// fb-rpc — FlatBuffer RPC library
//
// Wire format (binary envelope):
//   [1B type][1B reserved][2B method][4B id][4B body_len][body...]
//
// Where body is the raw FlatBuffer bytes of request/response.
// Errors use a simple format: [4B code][error_message...]

import * as flatbuffers from 'flatbuffers';

export { flatbuffers };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const enum MessageType {
    Request = 0,
    Notification = 1,
    Response = 2,
    ErrorResponse = 3,
}

/** FlatBuffer Table (zero-copy reader) */
export interface FBTable {
    __init(i: number, bb: flatbuffers.ByteBuffer): this;
}

/** FlatBuffer Object API (packable writer) */
export interface FBPackable {
    pack(builder: flatbuffers.Builder): flatbuffers.Offset;
}

export interface MethodDef<
    Req extends FBTable = FBTable,
    Res extends FBTable | void = void
> {
    Req: new () => Req;
    Res?: new () => Res & FBTable;
}

export type SchemaDef = Record<number, MethodDef<FBTable, FBTable | void>>;

/** Helper to define schema with proper typing */
export function defineSchema<T extends SchemaDef>(schema: T): T {
    return schema;
}

type ReqOf<S extends SchemaDef, M extends keyof S & number> =
    S[M] extends MethodDef<infer Req, any> ? Req : never;

type ResOf<S extends SchemaDef, M extends keyof S & number> =
    S[M] extends { Res: new () => infer R } ? R : void;

type HandlerReturn<S extends SchemaDef, M extends keyof S & number> =
    ResOf<S, M> extends void ? void | Promise<void> : FBPackable | Promise<FBPackable>;

export class FbRpcError extends Error {
    code: number;
    message: string;
    id: number;
    errorMessage: string;

    constructor(code: number, message: string, id: number = -1, errorMessage: string = '') {
        super(message);
        this.name = 'FbRpcError';
        this.code = code;
        this.message = message;
        this.id = id;
        this.errorMessage = errorMessage;
    }
}

export const FB_RPC_ERRORS = {
    PARSE_ERROR: {
        code: 1000,
        message: 'Failed to parse message'
    },
    INVALID_REQUEST: {
        code: 1001,
        message: 'Invalid request'
    },
    METHOD_NOT_FOUND: {
        code: 1002,
        message: 'Method not found'
    },
    INTERNAL_ERROR: {
        code: 1004,
        message: 'Internal error'
    },
    REQUEST_TIMEOUT: {
        code: 1005,
        message: 'Request has timed-out'
    },
    GUARD_ERROR: {
        code: 1006,
        message: 'Guard error'
    },
    APPLICATION_ERROR: {
        code: 1007,
        message: 'Application error'
    },
} as const;

// [1B type][1B reserved][2B method][4B id][4B body_len]
const HEADER_SIZE = 12;

// Inline byte writes (little-endian, avoids DataView creation)
function write16(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val;
    buf[offset + 1] = val >> 8;
}

function write32(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val;
    buf[offset + 1] = val >> 8;
    buf[offset + 2] = val >> 16;
    buf[offset + 3] = val >> 24;
}

function encodeMessage(type: MessageType, id: number, method: number, body: Uint8Array): Uint8Array {
    const msg = new Uint8Array(HEADER_SIZE + body.length);
    msg[0] = type;
    // msg[1] reserved
    write16(msg, 2, method);
    write32(msg, 4, id);
    write32(msg, 8, body.length);
    msg.set(body, HEADER_SIZE);
    return msg;
}

function encodeVoidResponse(id: number, method: number): Uint8Array {
    const msg = new Uint8Array(HEADER_SIZE);
    msg[0] = MessageType.Response;
    write16(msg, 2, method);
    write32(msg, 4, id);
    // body_len already 0
    return msg;
}

function encodeErrorResponse(id: number, code: number, message: string): Uint8Array {
    const msgBytes = textEncoder.encode(message);
    const body = new Uint8Array(4 + msgBytes.length);
    write32(body, 0, code);
    body.set(msgBytes, 4);
    return encodeMessage(MessageType.ErrorResponse, id, 0, body);
}

interface DecodedMessage {
    type: MessageType;
    id: number;
    method: number;
    body: Uint8Array;
}

// Inline byte reads (little-endian, avoids DataView creation)
function read16(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8);
}

function read32(buf: Uint8Array, offset: number): number {
    return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function readI32(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

function decodeMessage(data: Uint8Array): DecodedMessage {
    if (data.length < HEADER_SIZE) {
        throw new FbRpcError(FB_RPC_ERRORS.PARSE_ERROR.code, FB_RPC_ERRORS.PARSE_ERROR.message, -1, 'Message too short');
    }
    const type = data[0] as MessageType;
    const method = read16(data, 2);
    const id = read32(data, 4);
    const bodyLen = read32(data, 8);

    if (data.length < HEADER_SIZE + bodyLen) {
        throw new FbRpcError(FB_RPC_ERRORS.PARSE_ERROR.code, FB_RPC_ERRORS.PARSE_ERROR.message, -1, 'Incomplete message');
    }

    const body = data.subarray(HEADER_SIZE, HEADER_SIZE + bodyLen);
    return { type, id, method, body };
}

function decodeErrorResponse(body: Uint8Array): { code: number; message: string } {
    const code = readI32(body, 0);
    const message = textDecoder.decode(body.subarray(4));
    return { code, message };
}

function packFBWithBuilder(builder: flatbuffers.Builder, obj: FBPackable): Uint8Array {
    builder.clear();
    const offset = obj.pack(builder);
    builder.finish(offset);
    return builder.asUint8Array();
}

function unpackFB<T extends FBTable>(Ctor: new () => T, bytes: Uint8Array): T {
    const bb = new flatbuffers.ByteBuffer(bytes);
    const obj = new Ctor();
    return obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

const enum GuardType {
    Guard,
    RequestGuard,
    AppDataGuard
}

type AnyFunction = (...args: any[]) => any;

type Guard = {
    type: GuardType.Guard;
    fn: AnyFunction;
} | {
    type: GuardType.RequestGuard;
    fn: AnyFunction;
} | {
    type: GuardType.AppDataGuard;
    fn: AnyFunction;
};

interface HandlerEntry {
    Req: new () => FBTable;
    Res?: new () => FBTable;
    fn: AnyFunction;
    guards: Guard[];
}

export class DispatcherHandler<Req extends FBTable, AppDataType> {
    constructor(private entry: HandlerEntry) {}

    /** Add guard that receives (req, appData) */
    addGuard(fn: (req: Req, appData: AppDataType) => void): this {
        this.entry.guards.push({ type: GuardType.Guard, fn });
        return this;
    }

    /** Add guard that receives only (req) */
    addRequestGuard(fn: (req: Req) => void): this {
        this.entry.guards.push({ type: GuardType.RequestGuard, fn });
        return this;
    }

    /** Add guard that receives only (appData) */
    addAppDataGuard(fn: (appData: AppDataType) => void): this {
        this.entry.guards.push({ type: GuardType.AppDataGuard, fn });
        return this;
    }
}

interface PendingRequest {
    id: number;
    method: number;
    resolve: (value: FBTable | void) => void;
    reject: (error: Error) => void;
    timestamp: number;
}

const TIMEOUT_CHECK_INTERVAL_MS = 100;
const DEFAULT_BUILDER_SIZE = 256;

/** Global request ID counter (shared across all FbRpc instances for globally unique IDs) */
let requestIdCounter = 0;
const generateRequestId = () => (requestIdCounter = (requestIdCounter + 1) >>> 0);

export interface FbRpcOptions {
    /** Request timeout in milliseconds (default: 5000) */
    requestTimeout?: number;
    /** Initial FlatBuffers Builder size in bytes (default: 256) */
    builderInitialSize?: number;
}

export class FbRpc<S extends SchemaDef, AppDataType = void> {
    requestTimeout: number;
    toTransport: ((data: Uint8Array, appData: AppDataType) => void) | null = null;
    dispatcher: Map<number, HandlerEntry> = new Map();
    pendingRequests: Map<number, PendingRequest> = new Map();

    private readonly schema: S;
    private readonly builder: flatbuffers.Builder;
    private timeoutCheckInterval: ReturnType<typeof setInterval> | null = null;

    static encodeMessage = encodeMessage;
    static decodeMessage = decodeMessage;
    static encodeErrorResponse = encodeErrorResponse;
    static decodeErrorResponse = decodeErrorResponse;

    constructor(schema: S, options: FbRpcOptions = {}) {
        this.schema = schema;
        this.requestTimeout = options.requestTimeout ?? 5000;
        this.builder = new flatbuffers.Builder(options.builderInitialSize ?? DEFAULT_BUILDER_SIZE);
    }

    registerToTransportCallback(cb: (data: Uint8Array, appData: AppDataType) => void): void {
        this.toTransport = cb;
    }

    registerHandler<M extends keyof S & number>(
        method: M,
        handler: (req: ReqOf<S, M>, appData: AppDataType) => HandlerReturn<S, M>
    ): DispatcherHandler<ReqOf<S, M>, AppDataType> {
        const entry: HandlerEntry = {
            Req: this.schema[method].Req,
            Res: this.schema[method].Res,
            fn: handler,
            guards: [],
        };
        this.dispatcher.set(method, entry);
        return new DispatcherHandler<ReqOf<S, M>, AppDataType>(entry);
    }

    request<M extends keyof S & number>(
        method: M,
        req: FBPackable,
        appData: AppDataType
    ): Promise<ResOf<S, M>> {
        const id = generateRequestId();
        const body = this.packFB(req);
        const msg = encodeMessage(MessageType.Request, id, method, body);

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, {
                id,
                method,
                resolve: resolve as (v: FBTable | void) => void,
                reject,
                timestamp: performance.now(),
            });
            if (this.pendingRequests.size === 1) this.startTimeoutChecker();
            this.callToTransport(msg, appData);
        });
    }

    notify<M extends keyof S & number>(
        method: M,
        req: FBPackable,
        appData: AppDataType
    ): void {
        const body = this.packFB(req);
        this.callToTransport(encodeMessage(MessageType.Notification, 0, method, body), appData);
    }

    encodeNotification<M extends keyof S & number>(
        method: M,
        req: FBPackable,
    ): Uint8Array {
        const body = this.packFB(req);
        return encodeMessage(MessageType.Notification, 0, method, body);
    }

    fromTransport(data: Uint8Array, appData: AppDataType): void {
        let msg: DecodedMessage;
        try {
            msg = decodeMessage(data);
        } catch {
            this.callToTransport(
                encodeErrorResponse(-1, FB_RPC_ERRORS.PARSE_ERROR.code, FB_RPC_ERRORS.PARSE_ERROR.message),
                appData
            );
            return;
        }

        switch (msg.type) {
            case MessageType.Request:
            case MessageType.Notification:
                this.handleRequest(msg, appData);
                break;
            case MessageType.Response:
                this.handleResponse(msg);
                break;
            case MessageType.ErrorResponse:
                this.handleErrorResponse(msg);
                break;
        }
    }

    clean(reason: string): void {
        this.rejectPendingRequests(new FbRpcError(
            FB_RPC_ERRORS.INTERNAL_ERROR.code,
            FB_RPC_ERRORS.INTERNAL_ERROR.message,
            -1,
            reason
        ));
        this.resetDispatcher();
        this.stopTimeoutChecker();
        this.toTransport = null;
    }

    private packFB(obj: FBPackable): Uint8Array {
        return packFBWithBuilder(this.builder, obj);
    }

    private callToTransport(data: Uint8Array, appData: AppDataType): void {
        if (this.toTransport) {
            this.toTransport(data, appData);
        }
    }

    private rejectPendingRequests(error: FbRpcError): void {
        for (const request of this.pendingRequests.values()) {
            request.reject(error);
        }
        this.pendingRequests.clear();
        this.stopTimeoutChecker();
    }

    private resetDispatcher(): void {
        for (const handler of this.dispatcher.values()) {
            handler.guards.length = 0;
        }
        this.dispatcher.clear();
    }

    private startTimeoutChecker(): void {
        if (this.timeoutCheckInterval !== null) return;

        this.timeoutCheckInterval = setInterval(() => {
            const now = performance.now();
            const timedOutRequests: number[] = [];

            for (const [id, request] of this.pendingRequests.entries()) {
                if (now - request.timestamp >= this.requestTimeout) {
                    timedOutRequests.push(id);
                } else {
                    // Map is ordered by insertion, so if we find one that hasn't timed out,
                    // valid for fixed timeout duration, subsequent ones won't timeout either
                    break;
                }
            }

            for (const id of timedOutRequests) {
                const request = this.pendingRequests.get(id);
                if (request) {
                    this.pendingRequests.delete(id);
                    request.reject(new FbRpcError(
                        FB_RPC_ERRORS.REQUEST_TIMEOUT.code,
                        FB_RPC_ERRORS.REQUEST_TIMEOUT.message
                    ));
                }
            }

            if (this.pendingRequests.size === 0) {
                this.stopTimeoutChecker();
            }
        }, TIMEOUT_CHECK_INTERVAL_MS);
    }

    private stopTimeoutChecker(): void {
        if (this.timeoutCheckInterval !== null) {
            clearInterval(this.timeoutCheckInterval);
            this.timeoutCheckInterval = null;
        }
    }

    private handleRequest(msg: DecodedMessage, appData: AppDataType): void {
        const isNotif = msg.type === MessageType.Notification;
        const handler = this.dispatcher.get(msg.method);

        if (!handler) {
            if (!isNotif) {
                this.callToTransport(
                    encodeErrorResponse(msg.id, FB_RPC_ERRORS.METHOD_NOT_FOUND.code, FB_RPC_ERRORS.METHOD_NOT_FOUND.message),
                    appData
                );
            }
            return;
        }

        let req: FBTable;
        try {
            req = unpackFB(handler.Req, msg.body);
        } catch (e) {
            if (!isNotif) {
                this.callToTransport(
                    encodeErrorResponse(msg.id, FB_RPC_ERRORS.INVALID_REQUEST.code, (e as Error).message),
                    appData
                );
            }
            return;
        }

        // Execute guards
        const guardsLength = handler.guards.length;
        try {
            for (let i = 0; i < guardsLength; i++) {
                const guard = handler.guards[i];
                switch (guard.type) {
                    case GuardType.Guard:
                        guard.fn(req, appData);
                        break;
                    case GuardType.RequestGuard:
                        guard.fn(req);
                        break;
                    case GuardType.AppDataGuard:
                        guard.fn(appData);
                        break;
                }
            }
        } catch (e) {
            const err = e as Error;
            if (isNotif) return;

            this.callToTransport(
                encodeErrorResponse(msg.id, FB_RPC_ERRORS.GUARD_ERROR.code, err.toString()),
                appData
            );
            return;
        }

        // Execute handler
        const hasRes = handler.Res !== undefined;
        try {
            const result = handler.fn(req, appData);

            if (isNotif) return;

            if (result && typeof result.then === 'function') {
                (result as Promise<FBPackable | void>)
                    .then((res) => {
                        if (res === undefined || !hasRes) {
                            this.callToTransport(encodeVoidResponse(msg.id, msg.method), appData);
                        } else {
                            const body = this.packFB(res);
                            this.callToTransport(encodeMessage(MessageType.Response, msg.id, msg.method, body), appData);
                        }
                    })
                    .catch((e: Error) => {
                        this.callToTransport(
                            encodeErrorResponse(msg.id, FB_RPC_ERRORS.APPLICATION_ERROR.code, e.message),
                            appData
                        );
                    });
            } else if (result === undefined || !hasRes) {
                this.callToTransport(encodeVoidResponse(msg.id, msg.method), appData);
            } else {
                const body = this.packFB(result as FBPackable);
                this.callToTransport(encodeMessage(MessageType.Response, msg.id, msg.method, body), appData);
            }
        } catch (e) {
            const err = e as Error;
            if (isNotif) return;

            this.callToTransport(
                encodeErrorResponse(msg.id, FB_RPC_ERRORS.APPLICATION_ERROR.code, err.message),
                appData
            );
        }
    }

    private handleResponse(msg: DecodedMessage): void {
        const pendingRequest = this.pendingRequests.get(msg.id);
        if (!pendingRequest) return;

        this.pendingRequests.delete(msg.id);
        if (this.pendingRequests.size === 0) this.stopTimeoutChecker();

        // Void response (empty body)
        if (msg.body.length === 0) {
            pendingRequest.resolve(undefined);
            return;
        }

        try {
            const Res = this.schema[pendingRequest.method].Res;
            if (!Res) {
                // Schema says void but got body - resolve with undefined anyway
                pendingRequest.resolve(undefined);
                return;
            }
            const res = unpackFB(Res, msg.body);
            pendingRequest.resolve(res);
        } catch (e) {
            pendingRequest.reject(new FbRpcError(
                FB_RPC_ERRORS.INVALID_REQUEST.code,
                (e as Error).message,
                msg.id
            ));
        }
    }

    private handleErrorResponse(msg: DecodedMessage): void {
        const pendingRequest = this.pendingRequests.get(msg.id);
        if (!pendingRequest) return;

        this.pendingRequests.delete(msg.id);
        if (this.pendingRequests.size === 0) this.stopTimeoutChecker();

        const { code, message } = decodeErrorResponse(msg.body);
        pendingRequest.reject(new FbRpcError(code, message, msg.id));
    }
}
