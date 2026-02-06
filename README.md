# KISS-RPC-FB

KISS-RPC-FB is a high-performance RPC library for TypeScript that uses FlatBuffers for binary serialization instead of JSON. It provides schema-driven type safety, zero-copy deserialization, and a compact 12-byte binary envelope for minimal overhead. It works in Node.js environments.

## Transport
FB-RPC is transport agnostic. You can use it with any transport layer: WebSocket, TCP, IPC, stdio, message brokers, etc. The protocol is a simple binary format, so you can implement clients and servers in any language.

## Installation

```bash
npm install kiss-rpc-fb
```

## Prerequisites

FB-RPC requires the FlatBuffers compiler (`flatc`) to generate TypeScript code from `.fbs` schema files. Install it from the [FlatBuffers releases](https://github.com/google/flatbuffers/releases).

## Protocol Specification
FB-RPC has four types of messages: Request, Response, Error Response and Notification. All messages use a binary envelope format with a fixed 12-byte header.

```
Wire format: [1B type][1B reserved][2B method][4B id][4B body_len][body...]

Request        type=0, body=FlatBuffer request
Notification   type=1, body=FlatBuffer request
Response       type=2, body=FlatBuffer response (or empty for void)
Error Response type=3, body=[4B error_code][error_message...]
```
- **Request** is a stateful message, which requires a response.
- **Response** or **Error Response** are one of two possible outcomes of a request.
- **Notification** is a stateless message, which does not require a response.

Methods are identified by numeric IDs (defined in your FlatBuffer schema enum), not strings.

## Schema Definition

Define your RPC methods and message types in a `.fbs` schema file:

```flatbuffers
namespace Example;

enum Method: uint8 {
    ADD = 0,
    MULTIPLY = 1,
    GREET = 2,
    PING = 3,
}

table AddRequest { a: int32; b: int32; }
table AddResponse { result: int32; }

table MultiplyRequest { a: int32; b: int32; }
table MultiplyResponse { result: int32; }

table GreetRequest { name: string; }
table GreetResponse { message: string; }

// Void response - PING only has request, no response body
table PingRequest { timestamp: int64; }
```

Generate TypeScript code using the FlatBuffers compiler:

```bash
flatc --ts --gen-object-api -o src/generated schema/rpc.fbs
```

Then define a schema mapping that connects method IDs to their generated request/response types:

```typescript
import { defineSchema } from 'kiss-rpc-fb';
import {
    Method,
    AddRequest, AddResponse,
    MultiplyRequest, MultiplyResponse,
    GreetRequest, GreetResponse,
    PingRequest,
} from './generated/example';

export { Method };

export const schema = defineSchema({
    [Method.ADD]: { Req: AddRequest, Res: AddResponse },
    [Method.MULTIPLY]: { Req: MultiplyRequest, Res: MultiplyResponse },
    [Method.GREET]: { Req: GreetRequest, Res: GreetResponse },
    [Method.PING]: { Req: PingRequest },  // void response - no Res
});
```

## Type Safety
The main goal of FB-RPC is to provide type-safe RPC with compile-time guarantees driven by FlatBuffer schemas. The `FbRpc` class is generic over your schema definition, so TypeScript enforces correct method IDs, request types, and response types at compile time.

## Integration
Library provides two simple hooks to connect to/from the transport layer:
- **instance.registerToTransportCallback** registers a callback invoked when the library needs to send binary data to the other side.
- **instance.fromTransport** passes binary data received from the other side into the library.

```typescript
import { FbRpc } from 'kiss-rpc-fb';
import { schema, Method, AddRequestT } from './schema';

const rpc = new FbRpc<typeof schema>(schema, {
    // Optional. Default value is 5000ms.
    requestTimeout: 5000
});

rpc.registerToTransportCallback((data) => {
    // Logic to send binary data to transport.
});

myTransport.on('message', (data: Uint8Array) => {
    rpc.fromTransport(data, undefined);
});
```

## Usage Example

All examples omit transport layer implementation for simplicity.

### Simple Example

```typescript
import { FbRpc } from 'kiss-rpc-fb';
import {
    schema, Method,
    AddRequestT, AddResponseT,
    GreetRequestT, GreetResponseT,
} from './schema';

// Create client and server instances.
const client = new FbRpc<typeof schema>(schema, {
    requestTimeout: 5000
});

const server = new FbRpc<typeof schema>(schema, {
    requestTimeout: 5000
});

// Register callbacks. In this example we just forward directly.
client.registerToTransportCallback((data) => {
    server.fromTransport(data, undefined);
});

server.registerToTransportCallback((data) => {
    client.fromTransport(data, undefined);
});

// Register handlers on the server.
// Request object provides zero-copy field accessors.
server.registerHandler(Method.ADD, (req) => {
    return new AddResponseT(req.a() + req.b());
});

server.registerHandler(Method.GREET, (req) => {
    return new GreetResponseT(`Hello, ${req.name()}!`);
});

// Call methods on the server using request.
// Response object also provides zero-copy field accessors.
const addResp = await client.request(Method.ADD, new AddRequestT(10, 32), undefined);
console.log(addResp.result()); // 42

const greetResp = await client.request(Method.GREET, new GreetRequestT('World'), undefined);
console.log(greetResp.message()); // "Hello, World!"
```

### Void Response

Methods that don't return a response body (no `Res` in schema) resolve as `void`:

```typescript
server.registerHandler(Method.PING, (req) => {
    console.log(`ping received, ts=${req.timestamp()}`);
    // No return value needed
});

await client.request(Method.PING, new PingRequestT(BigInt(Date.now())), undefined);
```

### Notifications

Fire-and-forget messages that don't expect a response:

```typescript
client.notify(Method.PING, new PingRequestT(BigInt(Date.now())), undefined);
```

## App Data
FB-RPC provides a way to pass additional data to handlers. This is useful for context like user sessions or connection information.

```typescript
type Session = {
    userId: string;
    connectionId: number;
};

const client = new FbRpc<typeof schema>(schema);

// Server with AppData type parameter.
// This forces appData to be passed to fromTransport and makes it
// available in handlers.
const server = new FbRpc<typeof schema, Session>(schema);

client.registerToTransportCallback((data) => {
    // Provide session data when passing messages to the server.
    const session: Session = { userId: '123', connectionId: 1 };
    server.fromTransport(data, session);
});

server.registerToTransportCallback((data, appData) => {
    client.fromTransport(data, undefined);
});

// appData is available as the second argument in handlers.
server.registerHandler(Method.ADD, (req, session) => {
    console.log(`User ${session.userId} called ADD`);
    return new AddResponseT(req.a() + req.b());
});

const result = await client.request(Method.ADD, new AddRequestT(1, 2), undefined);
```

## Handler Guards
FB-RPC provides guards as middleware for handlers. Each handler can have one or more guards that execute before the handler. If any guard throws an error, the handler will not be executed and the error will be returned as an Error Response.

There are three types of guards:
- **Guard** - receives `(req, appData)`.
- **RequestGuard** - receives `(req)` only.
- **AppDataGuard** - receives `(appData)` only.

Guards are executed in the order they are registered. Guards can also be used as interceptors for logging.

```typescript
import { AddRequest } from './generated/example';

type Session = {
    userId: string;
    isAuthenticated: boolean;
};

const server = new FbRpc<typeof schema, Session>(schema);

function validateAuth(session: Session) {
    if (!session.isAuthenticated) {
        throw new Error('User is not authenticated');
    }
}

function validatePositive(req: AddRequest) {
    if (req.a() < 0 || req.b() < 0) {
        throw new Error('Values must be positive');
    }
}

function logRequest(req: AddRequest, session: Session) {
    console.log(`User ${session.userId} calling ADD(${req.a()}, ${req.b()})`);
}

// registerHandler returns a DispatcherHandler for chaining guards.
server.registerHandler(Method.ADD, (req, session) => {
    return new AddResponseT(req.a() + req.b());
}).addAppDataGuard(validateAuth)
  .addRequestGuard(validatePositive)
  .addGuard(logRequest);
```

## Error Handling
FB-RPC provides an `FbRpcError` class for error reporting. Errors thrown from handlers are returned as Error Responses. All errors from the library are instances of `FbRpcError`.

Error codes:

| Code | Name | Description |
|------|------|-------------|
| 1000 | PARSE_ERROR | Failed to parse binary message |
| 1001 | INVALID_REQUEST | Invalid or malformed request |
| 1002 | METHOD_NOT_FOUND | No handler registered for method |
| 1004 | INTERNAL_ERROR | Internal error (e.g. cleanup/shutdown) |
| 1005 | REQUEST_TIMEOUT | Request timed out |
| 1006 | GUARD_ERROR | Guard threw an error |
| 1007 | APPLICATION_ERROR | Handler threw an error |
