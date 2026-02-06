import { defineSchema } from '../../src';
import {
    Method,
    AddRequest, AddResponse,
    MultiplyRequest, MultiplyResponse,
    GreetRequest, GreetResponse,
    ShutdownRequest, ShutdownResponse,
    PingRequest,
} from './generated/example';

export { Method };
export * from './generated/example.js';

export const schema = defineSchema({
    [Method.ADD]: { Req: AddRequest, Res: AddResponse },
    [Method.MULTIPLY]: { Req: MultiplyRequest, Res: MultiplyResponse },
    [Method.GREET]: { Req: GreetRequest, Res: GreetResponse },
    [Method.SHUTDOWN]: { Req: ShutdownRequest, Res: ShutdownResponse },
    [Method.PING]: { Req: PingRequest },  // void response - no Res
});
