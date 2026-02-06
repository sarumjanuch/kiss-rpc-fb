import { defineSchema } from '../../src';
import {
    Method,
    SmallRequest, SmallResponse,
    MediumRequest, MediumResponse,
    LargeRequest, LargeResponse,
    VoidRequest,
    NotifyRequest,
} from './generated/benchmark';

export { Method };
export * from './generated/benchmark';

export const schema = defineSchema({
    [Method.ECHO_SMALL]: { Req: SmallRequest, Res: SmallResponse },
    [Method.ECHO_MEDIUM]: { Req: MediumRequest, Res: MediumResponse },
    [Method.ECHO_LARGE]: { Req: LargeRequest, Res: LargeResponse },
    [Method.VOID_OP]: { Req: VoidRequest },
    [Method.NOTIFY]: { Req: NotifyRequest },
});
