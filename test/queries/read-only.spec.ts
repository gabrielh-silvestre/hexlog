import { describe, expect, it } from '@jest/globals';
import { createQueryService } from '../../src/queries/query-service.ts';

type Deps = Parameters<typeof createQueryService>[0];

/** Só o `tsc` (`npm run typecheck`) confere o `@ts-expect-error`: o ts-jest roda com `isolatedModules`. */
const key = <T>(name: keyof T): keyof T => name;

const unused = (): never => {
  throw new Error('unused');
};

describe('createQueryService', () => {
  it('should see only the read side of the ports: no write, create or putText on the Readers', () => {
    expect(key<Deps['store']>('read')).toBeDefined();
    expect(key<Deps['definitions']>('names')).toBeDefined();
    expect(key<Deps['definitions']>('read')).toBeDefined();
    expect(key<Deps['attachments']>('status')).toBeDefined();
    // @ts-expect-error o serviço de consulta não grava no log
    expect(key<Deps['store']>('write')).toBeDefined();
    // @ts-expect-error nem cria processo
    expect(key<Deps['store']>('create')).toBeDefined();
    // @ts-expect-error nem grava definição
    expect(key<Deps['definitions']>('write')).toBeDefined();
    // @ts-expect-error nem grava anexo
    expect(key<Deps['attachments']>('putText')).toBeDefined();
    // @ts-expect-error nem grava anexo a partir de um arquivo
    expect(key<Deps['attachments']>('putPath')).toBeDefined();
  });

  it('should accept a fake with only the read side', () => {
    const service = createQueryService({
      store: { read: unused, readManifest: unused, list: () => [], listProjects: () => ['p'] },
      definitions: { names: () => [], versions: () => [], read: unused },
      attachments: { status: unused, read: unused },
      search: { search: () => [], terms: () => [] },
    });

    expect(service.list({})).toEqual({ projects: [{ name: 'p', processes: 0 }] });
  });
});
