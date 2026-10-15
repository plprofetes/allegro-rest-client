import type { RequestOptions } from './types'

/**
 * Types for `AllegroRestClient<paths>`. `paths` is the generated `paths` interface (or your own with the same shape);
 * with the default `{}` the client stays untyped. Everything here is compile-time only.
 */
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

type PathsWith<Paths, M extends Method> = {
  [P in keyof Paths]: Paths[P] extends Record<M, infer Op> ? (Op extends object ? P : never) : never
}[keyof Paths] &
  string

type OperationOf<Paths, P extends keyof Paths, M extends Method> = Paths[P] extends Record<M, infer Op> ? Op : never

type PathParamsOf<Op> = Op extends { parameters: { path: infer X } } ? X : undefined
type QueryOf<Op> = Op extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never
type HeaderOf<Op> = Op extends { parameters: { header?: infer H } } ? NonNullable<H> : never
type JsonBodyOf<Op> = Op extends { requestBody?: { content: infer C } } ? C[keyof C] : never

/** Bodies of the 2xx responses (any media type); `void` for responses without content. */
export type ResponseOf<Op> = Op extends { responses: infer R }
  ? {
      [S in keyof R & (200 | 201 | 202 | 203 | 204 | 205 | 206)]: R[S] extends { content: infer C } ? C[keyof C] : void
    }[keyof R & (200 | 201 | 202 | 203 | 204 | 205 | 206)]
  : unknown

type Opts<Op> = Omit<RequestOptions, 'method' | 'qs' | 'json' | 'params'> & {
  params?: { query?: QueryOf<Op>; header?: HeaderOf<Op> }
} & ([JsonBodyOf<Op>] extends [never] ? unknown : { json?: JsonBodyOf<Op> })

type OptsWithPath<Op> = Omit<Opts<Op>, 'params'> & {
  params: { path: PathParamsOf<Op>; query?: QueryOf<Op>; header?: HeaderOf<Op> }
}

export type TypedCall<Paths, M extends Method> = <P extends PathsWith<Paths, M>>(
  endpoint: P,
  ...args: PathParamsOf<OperationOf<Paths, P, M>> extends object
    ? [opts: OptsWithPath<OperationOf<Paths, P, M>>]
    : [opts?: Opts<OperationOf<Paths, P, M>>]
) => Promise<ResponseOf<OperationOf<Paths, P, M>>>

export type UntypedCall = <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>

/** Typed when `Paths` has any keys, otherwise the untyped call. */
export type Call<Paths, M extends Method> = [keyof Paths] extends [never] ? UntypedCall : TypedCall<Paths, M>
