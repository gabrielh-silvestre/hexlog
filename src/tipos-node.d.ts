// @types/node@24.8.1 ainda não declara `randomUUIDv7` (disponível desde o Node v24.16.0).
// `node:crypto` reexporta tudo de `crypto` (`export * from "crypto"` em
// node_modules/@types/node/crypto.d.ts), então a augmentation fica no módulo base.
declare module 'crypto' {
  function randomUUIDv7(): string;
}
