import { EventEmitter } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { GameConf } from "./states/room";
import {Game} from '../db/models/game';
import {AppDataSource} from '../db/datasource';
import { MetadataArgsStorage } from "typeorm/metadata-args/MetadataArgsStorage";
import { User } from "../db/models/user";

let dbInitialized = false;

AppDataSource.initialize().then(() => {
    dbInitialized = true;
}).catch(e => {
    console.log('db init failed', e);
})

const gameRepo = AppDataSource.getRepository(Game);
const userRepo = AppDataSource.getRepository(User);

interface AutohostResponse {
    action: string
    parameters: {
        info?: string
        title?: string
        status?: boolean
        [key: string]: any
    }
}


export class AutohostManager extends EventEmitter {
    allowedAutohosts: string[] = []
    server: WebSocketServer | null = null
    clients: {[key: string]: {
        ws: WebSocket,
        workload: number
    }} = {}
    hostedGames: {
        [key: string]: {
            running: boolean, 
            error: string, 
            ws: WebSocket | null, 
            game: Game, 
            lostMarks: {[key: number]: {
                team: number
                lost: boolean
                name: string
                isPlayer: boolean
            }},
        }
    } = {}

    constructor(allowedAutohost?: string[], 
        config?: {
        port: number,
        [key: string]: any
    }
    ) {
        super()

        if(allowedAutohost) this.allowedAutohosts = allowedAutohost;
        console.log(`autohosts allowed: ${this.allowedAutohosts.join(', ')}`)
        this.server = new WebSocketServer({
            port: config?.port || 9000,
            host: '0.0.0.0'
        })

        this.server.on('error', (err) => {
            console.log(err)
        })

        this.server.on('connection',(ws, req) => {

            this.emit('conn', ws, req)

            console.log(`autohost ${req.socket.remoteAddress} connected`)


            const autohostIP = req.socket.remoteAddress
            if(autohostIP) this.clients[autohostIP] = {
                ws,
                workload: 0
            };
            // if(autohostIP && autohostIP in this.allowedAutohosts) {
            // } else {
            //     ws.terminate()
            //     console.log(`autohost ${autohostIP} not allowed`)
            // }

            ws.on('message', async (data, _) => {
                // parse messages from autohost
                const msg = JSON.parse(data.toString()) as AutohostResponse
                console.log(`autohost msg: ${JSON.stringify(msg)}`)
                if(msg.action === 'serverStarted') {
                    console.log('server started by autohost')
                } else if(msg.action === 'serverEnding') {
                    console.log('server ended by autohost')
                }

                switch(msg.action) {
                    case 'serverStarted': {
                        if(msg.parameters.title) {
                            console.log(`autohost ${autohostIP} started game ${msg.parameters.title}`)
                            this.hostedGames[msg.parameters.title].running = true
                            this.hostedGames[msg.parameters.title].game.start_time = new Date()

                            gameRepo.save(this.hostedGames[msg.parameters.title].game).then(game => {
                                if(msg.parameters.title) this.hostedGames[msg.parameters.title].game = game;
                                console.log(`game ${game.id} started and saved`);
                            }).catch(e => {
                                console.log('save error', e);
                            })

                            this.emit('gameStarted', {
                                gameName: msg.parameters.title,
                                payload: {
                                    autohost: autohostIP,
                                    port: msg.parameters.port
                                }
                            })
                        } 
                        break;
                    }
                    case 'serverEnding': {
                        if(msg.parameters.title) {
                            this.hostedGames[msg.parameters.title].running = false
                            let winner_team = -1;
                            const lostMarks = this.hostedGames[msg.parameters.title].lostMarks;
                            for(const playerNum in lostMarks) {
                                if(lostMarks[playerNum].lost === false) {
                                    winner_team = lostMarks[playerNum].team;
                                    break;
                                }
                            }

                            this.hostedGames[msg.parameters.title].game.team_win = winner_team;
                            this.hostedGames[msg.parameters.title].game.end_time = new Date();


                            gameRepo.save(this.hostedGames[msg.parameters.title].game).then(g => {
                                console.log(`game ${g.id} result saved`);
                            }).catch(e => {
                                console.log('update error', e);
                            })

                            for(const playerNum in lostMarks) {
                                const player = lostMarks[playerNum]; 
                                if(player.isPlayer) {
                                    const user = await userRepo.findOne({
                                        where: {
                                            username: player.name
                                        }
                                    })
                                    if(user) {
                                        user.winCount += player.lost?0:1;
                                        user.loseCount += player.lost?1:0;
                                        userRepo.save(user).then(u => {
                                            console.log(`user ${user.username} winning count updated`);
                                        }).catch(e => {
                                            console.log(`user ${user.username} winning count error saving`);
                                        })
                                    }
                                }
                            }

                            this.hostedGames[msg.parameters.title].lostMarks

                            this.emit('gameEnded', msg.parameters.title)
                        }
                        break;
                    }
                    case 'workerExists': {
                        if(msg.parameters.title) {
                            this.emit('workerExists', msg.parameters.title)
                        }
                        break;
                    }
                    case 'midJoined': {
                        if(msg.parameters.title) {
                            this.emit('midJoined', msg.parameters)
                        }
                        break;
                    }
                    case 'info': {
                        console.log(msg.parameters.info)
                        break;
                    }
                    case 'defeat': {
                        const playerNumber: number = msg.parameters.playerNumber;
                        if(msg.parameters.title) 
                            this.hostedGames[msg.parameters.title].lostMarks[playerNumber].lost = true;
                        break;
                    }
                    default: {
                        this.emit('message', msg);
                        console.log(`autohost ${autohostIP} sent unknown message: ${msg.action}`)
                        break;
                    }
                }

            })

            ws.on('error', (err) => {
                console.log(err)
            })

            ws.on('close', (code, buffer) => {
                if(autohostIP) delete this.clients[autohostIP] 
                console.log(`autohost ${autohostIP} disconnected with code ${code}`)
            })
        })
    }

    start(gameConf: GameConf) {
        console.log(`game ${gameConf.title} starting`)
        this.hostedGames[gameConf.title] = {
            running: false,
            error: '',
            ws: null,
            game: new Game(),
            lostMarks: {},
        }

        for(const playerName in gameConf.team) {
            const playerNum = gameConf.team[playerName].index;
            const player = gameConf.team[playerName];
            if(!gameConf.team[playerName].isSpectator) {
                this.hostedGames[gameConf.title].lostMarks[playerNum] = {
                    team: player.team,
                    lost: false,
                    name: playerName,
                    isPlayer: !(player.isAI || player.isChicken)
                }
            }
        }
        console.log(`generated lost marks dict: `, this.hostedGames[gameConf.title].lostMarks);

        this.hostedGames[gameConf.title].lostMarks

        this.hostedGames[gameConf.title].game.game_config = this.serializeGameConf(gameConf);
        this.hostedGames[gameConf.title].game.team_win = -1;

        if(gameConf.mgr in this.clients) {
            this.clients[gameConf.mgr].workload += 1
            this.hostedGames[gameConf.title].ws = this.clients[gameConf.mgr].ws
            this.clients[gameConf.mgr].ws.send(JSON.stringify({
                action: 'startGame', 
                parameters: gameConf
            }))
            console.log(`sending game ${gameConf.title} configration to ${gameConf.mgr}`)
        } else {
            this.hostedGames[gameConf.title].error = 'Manager not connected'
            console.log(`autohost ${gameConf.mgr} not found`)
        }

    }
    midJoin(title: string, params: {
        playerName: string
        isSpec: boolean
        token: string
        team: string
        id: number
    }) {
        if(!this.hostedGames[title])
            return false;
        if(this.hostedGames[title].running) {
            this.hostedGames[title].ws?.send(JSON.stringify({
                action: 'midJoin',
                parameters: {
                    ...params,
                    title
                }
            }))
        }
    }

    loadBalance() {
        const workloadsPairs = Object.entries(this.clients)
            .map(([ip, client]) => [ip, client.workload])
            .sort((a, b) => {
                if(typeof a[1] === 'number' && typeof b[1] === 'number') {
                    return a[1] - b[1]
                }
                return 0
            })
        
        if(workloadsPairs.length > 0) return String(workloadsPairs[0][0])
        else return null
    }

    killEngine(params: {
        id: number
        title: string
    }) {
        if(!this.hostedGames[params.title])
            return false;
        if(this.hostedGames[params.title].running) {
            this.hostedGames[params.title].ws?.send(JSON.stringify({
                action: 'killEngine',
                parameters: params
            }))
            return true;
        } else {
            console.log(`game ${params.title} not hosted`)
            return false;
        }
    }

    serializeGameConf(gameConf: GameConf) {
        const map = gameConf.mapId; 
        const teams = gameConf.team;

        let mapStr = `map:${map};`
        let teamStr = '';
        for(const team in teams) {
            if(teams[team].isAI) teamStr += 'ai' + teams[team].team;
            else if(teams[team].isChicken) teamStr += 'chicken' + teams[team].team;
            else if(teams[team].isSpectator) {
                // do nothing for spectators
            } else {
                teamStr += team + teams[team].team;
            }

            teamStr += ',';
        }

        return mapStr + teamStr;
    }
}