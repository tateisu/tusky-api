import WebSocket from 'ws'
import express from 'express'
import axios from 'axios'
import bodyParser from 'body-parser'
import npmlog from 'npmlog'
import morgan from 'morgan'
import Sequelize from 'sequelize'

const app       = express()
const port      = process.env.PORT || 3000
const wsStorage = {}

const sequelize = new Sequelize('sqlite://tusky.sqlite', {
  logging: npmlog.verbose,
  storage: 'db/tusky.sqlite'
})

const appMap = JSON.parse( fs.readFileSync('db/app_map.json', 'utf8') );

const instanceMap = JSON.parse( fs.readFileSync('db/instance_map.json', 'utf8') );

const Registration = sequelize.define('registration', {
  instanceUrl: {
    type: Sequelize.STRING
  },

  accessToken: {
    type: Sequelize.STRING
  },

  appKey: {
    type: Sequelize.STRING
  }

  deviceToken: {
    type: Sequelize.STRING
  },

  deviceTokenUpdated: {
    type: Sequelize.STRING
  },

  lastUpdate: {
    type: Sequelize.BIGINT
    ,defaultValue: 0
  },
})


const connectForUser = (registration) => {

	var baseUrl = registration.instanceUrl;
	var accessToken = registration.accessToken;
	var appKey = registration.appKey;
	var deviceToken = registration.deviceToken;

	const ws_key = `${baseUrl}:${accessToken}:${deviceToken}:${appKey}`;
	const ws_key_safe = `${baseUrl}:${deviceToken}:${deviceToken}:***`;

	const log = (level, message) => npmlog.log(level, ws_key_safe, message)

	if( typeof wsStorage[ws_key] !== 'undefined' ){
		log('info', 'Already registered')
		return
	}

	let heartbeat

	log('info', 'New registration')

	const close = () => {
		clearInterval(heartbeat)
		disconnectForUser(registration);
	}

	const onMessage = data => {
		const json = JSON.parse(data)

		log('info', `New notification: ${json.event}`)

		if (json.event !== 'notification') {
			return
		}

		const payload = JSON.parse(json.payload)

		var param_device_token = registration.deviceTokenUpdated;
		if(!param_device_token) param_device_token = deviceToken;

		const firebaseMessage = {
			to: param_device_token,
			priority: 'high',
			data: { notification_id: payload.id }
		}

		axios.post(
			'https://fcm.googleapis.com/fcm/send'
			,JSON.stringify(firebaseMessage)
			,{
				headers: {
					'Authorization': `key=${serverKey}`
					,'Content-Type': 'application/json'
				}
			}
		).then(response => {
			// FCM送信のレスポンス

			log('info', `Sent to FCM, status ${response.status}: ${JSON.stringify(response.data)}`)

			if (response.data.failure === 0 && response.data.canonical_ids === 0) {
				return
			}

			response.data.results.forEach( result => {
				if (result.message_id && result.registration_id ){

					// デバイストークンが更新された
					registration.update({ deviceTokenUpdated: result.registration_id }	)

				} else if ( result.error === 'NotRegistered' ){
					close()
				}
			})
		}).catch(error => {
			log('error', `Error sending to FCM, status: ${error.response.status}: ${JSON.stringify(error.response.data)}`)
		})
	}

	const onError = error => {
		log('error', error)
		setTimeout(() => reconnect(), 5000)
	}

	const onClose = code => {
		if (code === 1000) {
			log('info', 'Remote server closed connection')
			clearInterval(heartbeat)
			close()
			return
		}

		log('error', `Unexpected close: ${code}`)
		setTimeout(() => reconnect(), 5000)
	}

	const reconnect = () => {

		clearInterval(heartbeat)

		const ws = new WebSocket(`${baseUrl}/api/v1/streaming/?access_token=${accessToken}&stream=user`)

		ws.on('open', () => {
			if (ws.readyState != 1) {
				log('error', `Client state is: ${ws.readyState}`)
			} else {
				log('info', 'Connected')
				heartbeat = setInterval(() => ws.ping(), 1000)
			}
		})

		ws.on('message', onMessage)
		ws.on('error', onError)
		ws.on('close', onClose)

		wsStorage[ws_key] = ws;
	}

	reconnect()
}

const disconnectForUser = (registration) => {

	const baseUrl = registration.instanceUrl;
	const accessToken = registration.accessToken;
	const appKey = registration.appKey;
	const deviceToken = registration.deviceToken;

	const ws_key = `${baseUrl}:${accessToken}:${deviceToken}:${appKey}`;
	const ws_key_safe = `${baseUrl}:${deviceToken}:${deviceToken}:***`;

	const log = (level, message) => npmlog.log(level, ws_key_safe, message)

	const ws = wsStorage[ws_key]
	if (typeof ws !== 'undefined') {
		ws.close()
		delete wsStorage[ws_key]
		log('info', 'WebSocket removed.')
	}
	
	registration.destroy();
	log('info', 'Registration destroyed.')
}

// DBに登録された項目のStreaming API 接続を復元する
Registration.sync()
.then(() => Registration.findAll())
.then(registrations => registrations.forEach( registration => {
	connectForUser( registration );
}))


app.use(morgan('combined'));
app.use(bodyParser.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.sendStatus(204)
})

app.post('/register', (req, res) => {

	const now = (new Date).getTime();

	/////////////////////////////////////
	// get firebase_key from app_id

	var appId = req.body.app_id;
	if( ! appId ){
		res.status(400).send('missing app_id');
		return;
	}

	var appEntry = appMap[ appId ];
	if( ! appEntry ){
		res.status(400).send('missing app configuration for app: ' + appId );
		return;
	}
	var appKey = appEntry[ 'firebase_key' ];
	if( ! appKey ){
		res.status(400).send('missing firebase_key configuration for app: ' + appId );
		return;
	}
	
	/////////////////////////////////////
	// check instance url 

	var instanceUrl = req.body.instance_url
	if( ! instanceUrl ){
		res.status(400).send('missing instance_url');
		return;
	}

	var instanceEntry = instanceMap[ instanceUrl ];
	if( ! instanceEntry ){
		instanceEntry = instanceMap[ '*' ];
		
		if( !instanceEntry ){
			res.status(400).send('missing instance configuration for instance: ' + instanceUrl );
			return;
		}
	}
	
	var entry = Registration.findOrCreate({
		where: {
			  instanceUrl: instanceUrl
			, accessToken: req.body.access_token
			, appKey: appKey
			, deviceToken: req.body.device_token
		}
	}).then( (registration) => {
		if (registration != null) {
			// 登録/更新された日時を覚えておく
			registration.update({
				lastUpdate: now
			} )
			// まだ接続してないなら再接続する
			connectForUser( registration );
		}
	})

	res.sendStatus(201)
})

app.post('/unregister', (req, res) => {

	/////////////////////////////////////
	// get firebase_key from app_id

	const appId = req.body.app_id;
	if( ! appId ){
		res.status(400).send('missing app_id');
		return;
	}

	const appEntry = appMap[ appId ];
	if( ! appEntry ){
		res.status(400).send('missing app configuration for app: ' + appId );
		return;
	}
	
	const appKey = appEntry[ 'firebase_key' ];
	if( ! appKey ){
		res.status(400).send('missing firebase_key configuration for app: ' + appId );
		return;
	}
	
	const entry = Registration.findOne({
		where: {
			  instanceUrl: req.body.instance_url
			, accessToken: req.body.access_token
			, appKey: appKey
			, deviceToken: req.body.device_token
		}
	}).then( (registration) => {
		if (registration != null) {
			disconnectForUser(registration)
		}
	})

	res.sendStatus(201)
})

app.listen(port, () => {
  npmlog.log('info', `Listening on port ${port}`)
})
