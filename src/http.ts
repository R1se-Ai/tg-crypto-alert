/** 与 Workers 全局 fetch 同签名，方便测试替换 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 默认 fetch 包装。
 * Workers 的 fetch 必须绑定 globalThis 调用（`fetch(...)`），
 * 一旦写成默认参数 `fetchFn = fetch` 解绑后调用会抛
 * "Illegal invocation: function called with incorrect `this` reference"。
 */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
