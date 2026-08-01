// `api delete <path> [--input <file|->] [--field k=v]…` — a raw-door M-class mutation (T-222 step
// 10c, kind:"direct"). The handler + preview are the shared mutation machinery bound to DELETE.
import { makeApiMutationHandler, makeApiMutationPreview } from "./shared";

export const apiDelete = makeApiMutationHandler("DELETE");
export const apiDeletePreview = makeApiMutationPreview("DELETE");
