import * as URL from 'url'
import * as path from 'path'
import * as http from 'http'
import * as net from 'net'
import { EventEmitter } from 'events'
import { listen } from 'socket.io'
import { connect } from 'socket.io-client'
import { AsyncFunctions, AsyncFunction, hookFunc, wrapFunc } from './utils'

export const DEFAULT_MESH_OPTS = {
    nodeName: '',
    announceInterval: 10 * 1000,
    remoteCallTimeout: 30 * 1000,
    listenOptions: undefined as net.ListenOptions | undefined,
}

export const DEFAULT_CALL_OPTS = {
    maxStackLength: 10,
    stack: [ ] as { nodeName: string, timestamp: number }[]
}

export interface ServiceRegistry {
    lastUpdated?: number,
}

export interface UpstreamRegistry extends ServiceRegistry {
    upstream: SocketIOClient.Socket,
}

export interface DownstreamRegistry extends ServiceRegistry {
    downstream: SocketIO.Socket,
}

export default class IOMesh extends EventEmitter {
    private isDestroyed = false
    private opts = { } as typeof DEFAULT_MESH_OPTS

    private upstreams = { } as { [URL: string]: UpstreamRegistry }
    private downstreams = { } as { [SockID: string]: DownstreamRegistry }
    private servers = { } as { io: SocketIO.Server, http: http.Server }

    private localRegistry = { } as { [Entry: string]: AsyncFunction }
    private downstreamRegistry = { } as { [Entry: string]: { [SockID: string]: DownstreamRegistry } }

    constructor(
            urls = [ ] as string | string[],
            api = { } as AsyncFunctions,
            opts = { } as Partial<typeof DEFAULT_MESH_OPTS>) {
        super()
        this.opts = { ...DEFAULT_MESH_OPTS, ...opts }
        this.opts.nodeName = this.opts.nodeName || 'n' + Math.random().toString().slice(2, 10)

        const httpServer = this.servers.http = http.createServer()
        httpServer.listen(this.opts.listenOptions, () => this.emit('listening'))

        const ioServer = this.servers.io = listen(httpServer)
        ioServer.on('connect', sock => this.acceptDownstream(sock))

        const ups = Array.isArray(urls) ? urls : [urls]
        ups.map(url => connect(url)).forEach(sock => this.connectToUpstream(sock))

        this.register(api)
        this.announceForever()
    }

    private async announceForever() {
        while (!this.isDestroyed) {
            await this.syncUpstream()
            await new Promise(resolve => setTimeout(resolve, this.opts.announceInterval))
        }
    }

    private connectToUpstream(upstream: SocketIOClient.Socket) {
        upstream.on('connect', () => {
            this.upstreams[upstream.io.uri] = { upstream }
            this.emit('upstream-connected', upstream)
            this.syncUpstream()
        })
        upstream.on('disconnect', () => {
            delete this.upstreams[upstream.io.uri]
            this.emit('upstream-disconnected', upstream)
        })
        upstream.on('service-remote-call', (input: any, callback: any) => {
            this.onRemoteCall(input).then(callback)
        })
    }

    private acceptDownstream(downstream: SocketIO.Socket) {
        const registry = { downstream }
        this.downstreams[downstream.id] = registry
        this.emit('downstream-connected', downstream)
        downstream.on('disconnect', async () => {
            delete this.downstreams[downstream.id]
            for (const entry in this.downstreamRegistry) {
                delete this.downstreamRegistry[downstream.id]
            }
            this.emit('downstream-disconnected', downstream)
            this.syncUpstream()
        })
        downstream.on('service-remote-call', (input, callback) => {
            this.onRemoteCall(input).then(callback)
        })
        this.syncUpstream()
    }

    syncUpstream() {
        const entries = Object.keys({ ...this.localRegistry, ...this.downstreamRegistry })
        return Promise.all(Object.keys(this.upstreams).map(async url => {
            const registry = this.upstreams[url]
            try {
                await this.remote(registry).sync(registry.upstream.id, entries)
            } catch (err) {
                console.error(`${this.opts.nodeName}: announce to ${url} failed`, err)
            }
        }))
    }

    private async onRemoteCall({ method, args }: { method: string, args: any[] }) {
        const resp = { } as { ret?: any, err?: Error }
        try {
            resp.ret = await (this as any)[method](...args)
        } catch (err) {
            resp.err = err
        }
        return resp
    }

    private callRemote<K extends keyof IOMesh>(sock: SocketIO.Socket | SocketIOClient.Socket, method: K): IOMesh[K] {
        return (...args: any[]) => new Promise((resolve, reject) => {
            setTimeout(reject, this.opts.remoteCallTimeout, Error(`timeout when dispatching ${method}`))
            const callback = ({ err, ret }: { err: Error, ret: any }) => err ? reject(err) : resolve(ret)
            ;(sock as any).emit('service-remote-call', { method, args }, callback)
        })
    }

    private remote(registry: UpstreamRegistry | DownstreamRegistry) {
        const sock = (registry as UpstreamRegistry).upstream || (registry as DownstreamRegistry).downstream
        return {
            call: this.callRemote(sock, 'call'),
            sync: this.callRemote(sock, 'sync'),
        }
    }

    async call(entry: string, args: any[], opts: typeof DEFAULT_CALL_OPTS): Promise<any> {
        const handler = this.localRegistry[entry]
        if (handler) {
            return await handler(...args)
        }
        opts = { ...opts, stack: opts.stack.concat({ nodeName: this.opts.nodeName, timestamp: Date.now() }) }
        if (opts.stack.length > opts.maxStackLength) {
            throw Error(`stack overflow for entry "${entry}"`)
        }
        const downstreamRegistry = Object.values(this.downstreamRegistry[entry] || { })
        for (const registry of [...downstreamRegistry, ...Object.values(this.upstreams)]) {
            return await this.remote(registry).call(entry, args, opts)
        }
        throw Error(`no service found for entry "${entry}"`)
    }

    async sync(sockId: string, entries: string[]): Promise<any> {
        const { downstream } = this.downstreams[sockId]
        for (const entry in this.downstreamRegistry) {
            delete this.downstreamRegistry[entry][sockId]
        }
        const lastUpdated = Date.now()
        for (const entry of entries) {
            const registries = this.downstreamRegistry[entry] || (this.downstreamRegistry[entry] = { })
            registries[sockId] = { downstream, lastUpdated }
        }
    }

    dir(prefix: string) {
        const entries = Object.keys({ ...this.localRegistry, ...this.downstreamRegistry })
                .filter(entry => entry.startsWith(prefix + '/'))
                .map(entry => entry.substr(prefix.length + 1).split('/'))
                .map(([name, ...rest]) => name + (rest.length ? '/' : ''))
        return Array.from(new Set(entries))
    }

    query<T extends AsyncFunctions>(api: T, opts = { } as Partial<typeof DEFAULT_CALL_OPTS>) {
        return hookFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return (...args: any[]) => this.call(entry, args, { ...DEFAULT_CALL_OPTS, ...opts })
        })
    }

    register<T extends AsyncFunctions>(api: T) {
        return wrapFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target }] = stack
            return this.localRegistry[entry] = target.bind(receiver)
        })
    }

    get network() {
        return {
            upstreams: Object.values(this.upstreams),
            downstreams: Object.values(this.downstreams),
            servers: this.servers,
        }
    }

    destroy() {
        for (const { upstream } of Object.values(this.upstreams)) {
            upstream.close()
        }
        this.servers.io.close()
        this.servers.http.close()
        this.isDestroyed = true
    }
}
