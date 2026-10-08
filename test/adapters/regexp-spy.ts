/** Quantas vezes um regex com a sentinela foi construído e executado durante `run`. */
export type RegExpUsage<T> = { result: T; constructions: number; executions: number };

/**
 * Espia de `RegExp` (não é spec): conta construções (`new RegExp`) e execuções (`test`/`exec`) de
 * regex cuja fonte contém `sentinel`. Instale antes de `createValidator()` e de compilar, e use um
 * validador novo por chamada: o `validate` memoiza a compilação por objeto de schema. Restaura o
 * `RegExp` global e os métodos do protótipo mesmo se `run` lançar.
 */
export function withRegExpSpy<T>(sentinel: string, run: () => T): RegExpUsage<T> {
  const OriginalRegExp = globalThis.RegExp;
  // `Reflect.get` guarda o método original sem o lint de `unbound-method`: ele é chamado com `call`.
  const test = Reflect.get(OriginalRegExp.prototype, 'test');
  const exec = Reflect.get(OriginalRegExp.prototype, 'exec');
  const usage = { constructions: 0, executions: 0 };

  globalThis.RegExp = new Proxy(OriginalRegExp, {
    construct(target, args: [string | RegExp, string?], newTarget) {
      if (String(args[0]).includes(sentinel)) usage.constructions++;
      return Reflect.construct(target, args, newTarget) as RegExp;
    },
  });
  OriginalRegExp.prototype.test = function (this: RegExp, value: string) {
    if (this.source.includes(sentinel)) usage.executions++;
    return test.call(this, value);
  };
  OriginalRegExp.prototype.exec = function (this: RegExp, value: string) {
    if (this.source.includes(sentinel)) usage.executions++;
    return exec.call(this, value);
  };

  try {
    return { result: run(), ...usage };
  } finally {
    globalThis.RegExp = OriginalRegExp;
    OriginalRegExp.prototype.test = test;
    OriginalRegExp.prototype.exec = exec;
  }
}
