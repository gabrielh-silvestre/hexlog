import { describe, test, expect } from '@jest/globals';
import { parseFlowMap } from '../src/flow-map.ts';

const MINIMAL_VALID = `---
phases:
  - discovery
process:
  discovery: proc-discovery
---
corpo em markdown
`;

describe('parseFlowMap', () => {
  test('frontmatter válido mínimo faz roundtrip com os defaults', () => {
    const result = parseFlowMap(MINIMAL_VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.phases).toEqual(['discovery']);
    expect(result.data.process).toEqual({ discovery: 'proc-discovery' });
    expect(result.data.skills).toEqual({});
    expect(result.data.gate).toEqual({});
    expect(result.data.hook).toBe(false);
    expect(result.data.editedSkills).toEqual([]);
    expect(result.data.targetIdPattern).toBe('[^\\s:]+');
  });

  test('gate referenciando uma fase fora de phases rejeita com issues', () => {
    const text = `---
phases:
  - discovery
process:
  discovery: proc-discovery
gate:
  planning: custom-gate
---
`;
    const result = parseFlowMap(text);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test('targetIdPattern com regex inválida é rejeitado', () => {
    const text = `---
phases:
  - discovery
process:
  discovery: proc-discovery
targetIdPattern: "["
---
`;
    expect(parseFlowMap(text).success).toBe(false);
  });

  test('editedSkills com item não-string rejeita com issues', () => {
    const text = `---
phases:
  - discovery
process:
  discovery: proc-discovery
editedSkills:
  - 42
---
`;
    const result = parseFlowMap(text);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test('skill namespaced com : (ex. oh-my-claudecode:ralph) é aceita em skills', () => {
    const text = `---
phases:
  - discovery
process:
  discovery: proc-discovery
skills:
  discovery:
    - oh-my-claudecode:ralph
---
`;
    const result = parseFlowMap(text);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.skills).toEqual({ discovery: ['oh-my-claudecode:ralph'] });
  });

  test('fase declarada sem processo mapeado rejeita com mensagem específica', () => {
    const text = `---
phases:
  - discovery
  - planning
process:
  discovery: proc-discovery
---
`;
    const result = parseFlowMap(text);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toContainEqual(
      expect.stringContaining('phase "planning" has no process mapped'),
    );
  });
});
