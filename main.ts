import "reflect-metadata"
import { randomInt } from "crypto";
import { Worker, parentPort, threadId } from "worker_threads";
import { Network, IncommingMsg } from "./lib/network";
import { State } from "./lib/state";
import { Receipt } from "./worker";
import {User} from './lib/states/user';
import {User as DBUser} from './db/models/user';
import { Chat, ChatRoom as DBChatRoom } from "./db/models/chat";
import { ChatRoom } from "./lib/states/chat";
import { fullfillParameters, CMD_PARAMETERS, getMods } from "./lib/util";
import { GameRoom } from "./lib/states/room";
import { AutohostManager } from "./lib/autohost";
import { IncomingMessage } from "http";
import { selfIP } from "./config";

let mods: string[] = [];
getMods().then(res => {
    mods = res;
})
const state: State = new State();
const workers: Worker[] = [];
const network: Network = new Network(8081);
const autohostMgr: AutohostManager = new AutohostManager(['127.0.0.1, ::ffff:127.0.0.1'], {
    port: 5000
})

// clientID -> username
const clientID2username: Record<string, string> = {};
const username2clientID: Record<string, string> = {};
// seq -> clientID
const seq2respond: Record<number, string> = {};
let seqCount = 0
// this should be used as battlePort of games 
// that need to be dispatched into autohosts
let autohostLoad: {[key:string]: number} = {}

for(let i=0; i<4; i++) {
    let worker = new Worker('./worker.js');
    worker.on('online', () => {
        console.log(`Worker ${worker.threadId} online`);
    })
    worker.on('exit', (code) => {
        console.log(`worker ${worker.threadId} exited with code ${code}`);
    })
    worker.on('message', async (msg: Receipt) => {
        switch(msg.receiptOf) {
            case 'LOGIN': {
                if(msg.status) {
                    const user: DBUser = msg.payload.user;
                    const stateUser = new User(user);
                    console.log(stateUser);
                    clientID2username[seq2respond[msg.seq]] = user.username;
                    username2clientID[user.username] = seq2respond[msg.seq];

                    state.addUser(stateUser);
                    console.log(stateUser)

                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'LOGIN',
                        seq: msg.seq,
                        state: state.dump(stateUser.username)
                    })
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }

                break;
            }
            case 'JOINCHAT': {
                const chatRoom: DBChatRoom = msg.payload.chatRoom;
                if(msg.status) {
                    if(msg.payload.type === 'CREATE') {
                        const stateChatRoom = new ChatRoom(chatRoom);
                        const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                        if(user!==null) {
                            stateChatRoom.join(user);
                            // may be problematic due to race
                            state.addChat(stateChatRoom);
                            await state.assignChat(stateChatRoom.roomName, stateChatRoom);
                            console.log(stateChatRoom)

                            network.emit('postMessage', seq2respond[msg.seq], {
                                action: 'JOINCHAT',
                                seq: msg.seq,
                                state: state.dump(user.username)
                            })
                        }
                    } else if(msg.payload.type === 'JOIN') {
                        console.log('joining')
                        const stateChatRoom = state.getChat(chatRoom.roomName);
                        console.log(stateChatRoom);
                        if(stateChatRoom === null) {
                            network.emit('postMessage', seq2respond[msg.seq], {
                                action: 'NOTIFY',
                                seq: msg.seq,
                                message: 'Chat room may be dismissed',
                            })
                            break;
                        }

                        const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                        if(user !== null) {
                            stateChatRoom.join(user);
                            await state.assignChat(stateChatRoom.roomName, stateChatRoom);
                            console.log(stateChatRoom)
                            network.emit('postMessage', seq2respond[msg.seq], {
                                action: 'JOINCHAT',
                                seq: msg.seq,
                                state: state.dump(user.username)
                            })
                        }
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                state.releaseChat(chatRoom.roomName);
                break;
            }
            case 'SAYCHAT': {
                console.log(msg.payload.chat);
                let chat = msg.payload.chat;
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }
                if(msg.status) {
                    chat = Object.assign(new ChatRoom(msg.payload.chat), msg.payload.chat);
                    await state.assignChat(chat.roomName, chat);
                    console.log('main: ', chat)

                    for(const member of chat.members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SAYCHAT',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                    chat.lastMessage.content = '';
                    chat.lastMessage.author = '';
                    await state.assignChat(chat.roomName, chat);
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(chat) state.releaseChat(chat.roomName);
                break;
            }
            case 'LEAVECHAT': {
                if(msg.status) {
                    const chat: ChatRoom = Object.assign(new ChatRoom(msg.payload.chat), msg.payload.chat);
                    const user = state.getUser(clientID2username[seq2respond[msg.seq]]);

                    await state.assignChat(chat.roomName, chat);
                    console.log(chat)
                    
                    if(chat.empty()) {
                        await state.removeChat(chat.roomName)
                    }

                    const members = chat.members;
                    if(user !== null) members.push(user.username);

                    for(const member of chat.members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'LEAVECHAT',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }

                    state.releaseChat(chat.roomName);
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                break;
            }
            case 'JOINGAME': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                console.log(game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be logged out',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }

                const actionType: string = msg.payload.type;

                if(msg.status) {
                    if(actionType === 'CREATE') {
                        state.addGame(game);
                        await state.assignGame(game.title, game);
                        // network.emit('postMessage', seq2respond[msg.seq], {
                        //     action: 'JOINGAME',
                        //     seq: msg.seq,
                        //     state: state.dump(clientID2username[seq2respond[msg.seq]])
                        // })

                        for(const username of Object.keys(username2clientID)) {
                            network.emit('postMessage', username2clientID[username], {
                                action: 'JOINGAME',
                                seq: msg.seq,
                                state: state.dump(username)
                            })
                        }
                    } else if(actionType === 'JOIN') {
                        console.log(`user ${user.username} joining game ${game.title}`)
                        await state.assignGame(game.title, game);
                        // network.emit('postMessage', seq2respond[msg.seq], {
                        //     action: 'JOINGAME',
                        //     seq: msg.seq,
                        //     state: state.dump(clientID2username[seq2respond[msg.seq]])
                        // })

                        const players = Object.keys(game.players);
                        for(const player of players) {
                            network.emit('postMessage', username2clientID[player], {
                                action: 'JOINGAME',
                                seq: msg.seq,
                                state: state.dump(player)
                            })
                        }
                    } else {
                        console.log('unknown action type')
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'NOTIFY',
                            seq: msg.seq,
                            message: 'Something wrong happend: Unknown action type',
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'MIDJOIN': {
                console.log('receiving midjoin, returning');
                if(msg.status) {
                    const {title, playerName, token, isSpec, team, id} = msg.payload;
                    autohostMgr.midJoin(title, {
                        playerName,
                        token,
                        isSpec,
                        team,
                        id,
                    });
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'MIDJOIN',
                        seq: msg.seq,
                        state: state.dump(clientID2username[seq2respond[msg.seq]])
                    })
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                break;
            }
            case 'SETAI': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                console.log(game)
                if(msg.status) {
                    await state.assignGame(game.title, game);

                    const members = Object.keys(game.players); 
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETAI',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'DELAI': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                console.log(game)
                if(msg.status) {
                    await state.assignGame(game.title, game);

                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'DELAI',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'SETTEAM': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                console.log(game)
                const members = Object.keys(game.players);
                if(msg.status) {
                    await state.assignGame(game.title, game);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETTEAM',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'SETSPEC': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                if(msg.status) {
                    await state.assignGame(game.title, game);
                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETSPEC',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }

                if(game) state.releaseGame(game.title);
                break;
            }
            case 'SETMAP': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                console.log(game)
                const members = Object.keys(game.players);
                if(msg.status) {
                    await state.assignGame(game.title, game);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETMAP',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'SETMOD': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                if(msg.status) {
                    await state.assignGame(game.title, game);
                    console.log('assinged game in setmod: ', user.game);
                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETMOD',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'HASMAP': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }
                if(msg.status) {
                    await state.assignGame(game.title, game);
                    console.log('assinged game in hasmap: ', user.game);
                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'HASMAP',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break
            }
            case 'STARTGAME': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                console.log('responding');
                const start: boolean = msg.payload.start;
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break;
                }

                if(msg.status) {
                    await state.assignGame(game.title, game);

                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'STARTGAME',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                    if(start) {
                        const config = game.configureToStart();
                        // console.log(game.players);
                        // console.log(game.ais);
                        // console.log(config);
                        autohostMgr.start(config)
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'LEAVEGAME': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    if(game) state.releaseGame(game.title);
                    break; 
                }

                if(game === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'Game may be dismissed',
                    })
                    break;
                }

                if(msg.status) {
                    user.game = null;
                    await state.assignUser(user.username, user);

                    if(msg.payload.dismiss) {
                        const members = Object.keys(game.players);
                        members.push(clientID2username[seq2respond[msg.seq]]);
                        await state.removeGame(game.title);                   
                        for(const member of members) {
                            network.emit('postMessage', username2clientID[member], {
                                action: 'LEAVEGAME',
                                seq: msg.seq,
                                state: state.dump(member)
                            })
                        }
                    } else {
                        const members = Object.keys(game.players);
                        members.push(clientID2username[seq2respond[msg.seq]]);
                        await state.assignGame(game.title, game);
                        for(const member of members) {
                            network.emit('postMessage', username2clientID[member], {
                                action: 'LEAVEGAME',
                                seq: msg.seq,
                                state: state.dump(member)
                            })
                        }
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                break;
            }
            case 'KILLENGINE': {
                const game = msg.payload.game; 
                if(msg.status) {
                    if(!game) {
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'NOTIFY',
                            seq: msg.seq,
                            message: 'Game may be dismissed',
                        })
                        break;
                    }
                    const res = autohostMgr.killEngine({
                        id: game.id,
                        title: game.title
                    });
                    if(res) {
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'KILLENGINE',
                            seq: msg.seq,
                            state: state.dump(clientID2username[seq2respond[msg.seq]])
                        })
                    } else {
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'NOTIFY',
                            seq: msg.seq,
                            message: 'OPERATION NOT INITED!',
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                break;
            }

            case 'ADDFRIEND': {
                if(!msg.status) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message
                    })
                    break;
                }

                network.emit('postMessage', seq2respond[msg.seq], {
                    action: 'ADDFRIEND',
                    seq: msg.seq,
                    state: state.dump(clientID2username[seq2respond[msg.seq]])
                })
                break;
            }
            case 'CLAIMCONFIRM': {
                if(!msg.status) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message
                    })
                    break;
                }
                const user: User = Object.assign(new User(msg.payload.user), msg.payload.user);
                await state.assignUser(user.username, user);
                network.emit('postMessage', seq2respond[msg.seq], {
                    action: 'CLAIMCONFIRM',
                    seq: msg.seq,
                    state: state.dump(clientID2username[seq2respond[msg.seq]])
                })

                if(user) state.releaseUser(user.username);
                break;
            }
        }
        delete seq2respond[msg.seq];
    })

    workers.push(worker)
}

network.on('message', async (clientId: string, msg: IncommingMsg) => {
    let worker = workers[randomInt(0, workers.length)];


    console.log(`msg from ${clientId} with seq ${msg.seq}`)

    if(msg.action === 'GETSEQ') {
        network.emit('postMessage', clientId, {
            action: 'GETSEQ',
            seq: seqCount,
        })

        seqCount++;
        if(seqCount > 10000000000) seqCount = 0;

        return;
    }

    if(!(msg.action in CMD_PARAMETERS) 
        || !(fullfillParameters(msg.action as keyof typeof CMD_PARAMETERS, msg.parameters))) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            seq: msg.seq,
            message: 'Invalid parameters',
        })
        return;
    }


    if(!msg.seq) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            message: 'seq not found',
        });
        return
    }
    if(msg.seq in seq2respond) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            message: 'seq already used',
        });
        return
    }


    // record in mem only if message have seq, right cmd and sufficient parameters
    seq2respond[msg.seq] = clientId;


    if(msg.action === 'LOGIN') {
        if(!(msg.parameters.username in username2clientID)) worker.postMessage(msg);
        else {
            network.emit('postMessage', clientId, {
                action: 'NOTIFY',
                seq: msg.seq,
                message: 'user already loggged in'
            })
            delete seq2respond[msg.seq]
        }
        return;
    }
    if(!clientID2username[clientId]) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            seq: msg.seq,
            message: 'please login to access',
        })
        return
    }

    switch(msg.action) {
        case 'JOINCHAT': {
            const chat = state.getChat(msg.parameters.chatName);
            if(!(chat === null)) await state.lockChat(chat.roomName);

            msg.payload = {
                chat: chat
            }
            worker.postMessage(msg);
            break;
        }
        case 'SAYCHAT': {
            const chat = state.getChat(msg.parameters.chatName);
            if(!(chat === null)) await state.lockChat(chat.roomName);

            msg.payload = {
                chat,
                user: state.getUser(clientID2username[clientId])
            }
            worker.postMessage(msg);
            break;
        }
        case 'LEAVECHAT': {
            const chat = state.getChat(msg.parameters.chatName);
            if(!(chat === null)) await state.lockChat(chat.roomName);

            msg.payload = {
                chat: state.getChat(msg.parameters.chatName),
                user: state.getUser(clientID2username[clientId])
            }
            worker.postMessage(msg);
            break;
        }
        case 'JOINGAME': {
            const autohosts = Object.keys(autohostLoad);
            if(autohosts.length <= 0) {
                network.emit('postMessage', clientId, {
                    action: 'NOTIFY',
                    seq: msg.seq,
                    message: 'No autohost available',
                })

                delete seq2respond[msg.seq];
                return;
            }

            const game = state.getGame(msg.parameters.gameName);
            if(!(game === null)) {
                await state.lockGame(game.title);

                msg.payload = {
                    game: game,
                    user: state.getUser(clientID2username[clientId]),
                }
            } else {
                // TODO: use AutohostManager to load balance
                const autohost = autohosts[randomInt(0, autohosts.length)];

                msg.payload = {
                    game: game,
                    user: state.getUser(clientID2username[clientId]),
                    autohost: autohost,
                    roomID: autohostLoad[autohost]
                }

                autohostLoad[autohost]++;
            }

            worker.postMessage(msg);
            break;
        }
        case 'MIDJOIN': {
            const user = state.getUser(clientID2username[clientId]);
            const game = user?.game
            
            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }
            worker.postMessage(msg);

            break;

        }
        case 'SETAI': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);
            
            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }
            worker.postMessage(msg);

            break;
        }
        case 'DELAI': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'SETTEAM': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'SETSPEC': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }
            worker.postMessage(msg);

            break;
        }
        case 'SETMAP': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'SETMOD': {
            const user = state.getUser(clientID2username[clientId]);
            const game =  user?.game;

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user,
                mods
            }

            worker.postMessage(msg);
            break;
        }
        case 'HASMAP': {
            const user = state.getUser(clientID2username[clientId]);
            const game = user?.game;

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'STARTGAME': {
            const user = state.getUser(clientID2username[clientId]);
            const game = user?.game

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);
            break;
        }
        case 'LEAVEGAME': {
            console.log('called leavegame');
            const user = state.getUser(clientID2username[clientId]);
            const game = user?.game

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);
            break;
        }
        case 'KILLENGINE': {
            const user = state.getUser(clientID2username[clientId]);
            const game = user?.game

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);
            break;
        }
        case 'ADDFRIEND': {
            const user = state.getUser(clientID2username[clientId]);

            msg.payload = {
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'CLAIMCONFIRM': {
            const user = state.getUser(clientID2username[clientId]);
            if(user) state.lockUser(user.username);

            msg.payload = {
                user
            }

            worker.postMessage(msg);
            break;
        }
    }
})

network.on('clean', async (clientID: string) => {
    const user = state.getUser(clientID2username[clientID])
    // console.log(`${user?.username} disconnected, preparing for cleaning`)
    if(user) {
       const gcRes = await state.garbageCollect(user) 
       for(const player of gcRes.users2notify) {
        network.emit('postMessage', username2clientID[player], {
            action: 'DISCONNECT',
            seq: -1,
            state: state.dump(player)
        })
       }
    }

    delete clientID2username[clientID];
    if(user) delete username2clientID[user?.username];

    // needs optimization, cur: O(n)
    for(const seq in seq2respond) {
        if(seq2respond[seq] === clientID) {
            delete seq2respond[seq];
        }
    }
})

autohostMgr.on('conn', (ws: WebSocket, req: IncomingMessage) => {
    if(req.socket.remoteAddress) autohostLoad[req.socket.remoteAddress] = 0;
})
autohostMgr.on('gameStarted', (startedInfo: {
    gameName: string,
    payload : {
        autohost: string,
        port: number,
    }
}) => {
    console.log('receieved gameStarted event')
    const game = state.getGame(startedInfo.gameName);
    if(game) {
        state.lockGame(startedInfo.gameName);
        game.isStarted = true;  
        if(['127.0.0.1', '::ffff:127.0.0.1'].includes(startedInfo.payload.autohost)) {
            game.responsibleAutohost = selfIP;
        } else {
            game.responsibleAutohost = startedInfo.payload.autohost;
        }
        game.autohostPort = startedInfo.payload.port;
        state.assignGame(startedInfo.gameName, game);
        for(const user in game.players) {
            network.emit('postMessage', username2clientID[user], { 
                action: 'GAMESTARTED',
                seq: -1,
                state: state.dump(user),
            })
        }

        state.releaseGame(startedInfo.gameName);
    }
}) 
autohostMgr.on('gameEnded', (roomName: string) => {
    const game = state.getGame(roomName);
    console.log('receieved gameEned event')
    if(game) {
        state.lockGame(roomName);
        game.isStarted = false;
        // game.responsibleAutohost = '';
        // game.autohostPort = 0;
        state.assignGame(roomName, game);
        for(const user in game.players) {
            network.emit('postMessage', username2clientID[user], { 
                action: 'GAMEENDED',
                seq: -1,
                state: state.dump(user),
            })
        }

        state.releaseGame(roomName);
        console.log("locked?: ", state.rooms[roomName].mutex.isLocked());
    }
})

autohostMgr.on('workerExists', (roomName: string) => {
    const game = state.getGame(roomName);
    if(game) {
        state.lockGame(roomName);
        game.isStarted = true;
        state.assignGame(roomName, game);
        for(const user in game.players) {
            network.emit('postMessage', username2clientID[user], { 
                action: 'WORKEREXISTS',
                seq: -1,
                state: state.dump(user),
            })
        }

        state.releaseGame(roomName);
    }
})

autohostMgr.on('midJoined', (param: {
    title: string
    player: string
}) => {
    const user = state.getUser(param.player);
    console.log('midjoin: ', user);
    if(user) {
        network.emit('postMessage', username2clientID[user.username], {
            action: 'MIDJOINED',
            seq: -1,
            state: state.dump(user.username),
        })
    }
})

autohostMgr.on('message', (msg: {
    action: string
    parameters: {
        id: number
        title: string
    }
}) => {
    const game = state.getGame(msg.parameters.title);
    if(game) {
        for(const user in game.players) {
            network.emit('postMessage', username2clientID[user], { 
                action: msg.action,
                seq: -1,
                state: state.dump(user),
            })
        }
    }
})

// timer functions
// update mods every 5 mins
setInterval(async () => {
    mods = await getMods();
    console.log(`mods set: ${mods}`)
}, 60 * 5 * 1000)