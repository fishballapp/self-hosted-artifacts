import { expect, it } from 'vitest';
import { ARTIFACT_ID, newArtifactId } from './protocol.ts';

it('makes IDs a command line reads as a value, in the shape every target holds them to', () => {
  // Without the rule, 1,000 of them holding no leading `-` would be a one in ten million chance.
  const ids = Array.from({ length: 1_000 }, newArtifactId);
  expect(ids.filter(id => !ARTIFACT_ID.test(id))).toEqual([]);
  expect(ids.filter(id => id.startsWith('-'))).toEqual([]);
  expect(new Set(ids).size).toBe(ids.length);
});
