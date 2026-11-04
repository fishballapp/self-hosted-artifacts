import { expect, it } from 'vitest';
import { ARTIFACT_ID, attachmentOf, isFileName, newArtifactId } from './protocol.ts';
import { unescapeXml } from './s3-bucket.ts';

it('makes IDs a command line reads as a value, in the shape every target holds them to', () => {
  // Without the rule, 1,000 of them holding no leading `-` would be a one in ten million chance.
  const ids = Array.from({ length: 1_000 }, newArtifactId);
  expect(ids.filter(id => !ARTIFACT_ID.test(id))).toEqual([]);
  expect(ids.filter(id => id.startsWith('-'))).toEqual([]);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each([
  'app.apk',
  'a space.zip',
  '.env',
  '-flag',
  '...',
  "what upstream allows [v1] (x+y) & z=1; 100% #2 ~'.zip",
  '你好.apk',
  'a'.repeat(255),
])('takes %s as a name', name => {
  expect(isFileName(name)).toBe(true);
});

it.each([
  ['nothing', ''],
  ['the current folder', '.'],
  ['the parent folder', '..'],
  ['nothing, once a folder leaves off its `.zip`', '.zip'],
  ['the current folder, as a folder leaves off its `.zip`', '..zip'],
  ['the parent folder, as a folder leaves off its `.zip`', '...zip'],
  ['the parent folder, whatever the case', '...ZIP'],
  ['a legacy workflow command', '##[stop-commands]pause.zip'],
  ['a legacy workflow command further in', 'a ##[error]b'],
  ['a slash', 'a/b'],
  ['a backslash', 'a\\b'],
  ['a double quote', 'a"b'],
  ['a colon', 'a:b'],
  ['a less than', 'a<b'],
  ['a greater than', 'a>b'],
  ['a bar', 'a|b'],
  ['an asterisk', 'a*b'],
  ['a question mark', 'a?b'],
  ['a line feed', 'a\nb'],
  ['a carriage return', 'a\rb'],
  ['a line feed at the end', 'a\n'],
  ['a NUL', 'a\0b'],
  ['a delete', 'a\x7fb'],
  ['half a surrogate pair', 'a\ud800b'],
  ['256 bytes', 'a'.repeat(256)],
  ['256 bytes in fewer characters', 'é'.repeat(128)],
])('refuses %s as a name', (_, name) => {
  expect(isFileName(name)).toBe(false);
});

it.each([
  ['a plain name', 'a b.apk', 'attachment; filename="a b.apk"'],
  [
    'non-ASCII',
    '你好.apk',
    `attachment; filename="__.apk"; filename*=UTF-8''%E4%BD%A0%E5%A5%BD.apk`,
  ],
  ['a percent sign', '100%.apk', `attachment; filename="100_.apk"; filename*=UTF-8''100%25.apk`],
  [
    "what a header's extended form would end at",
    "é'().apk",
    `attachment; filename="_'().apk"; filename*=UTF-8''%C3%A9%27%28%29.apk`,
  ],
])('names %s in a header', (_, name, header) => {
  expect(attachmentOf(name)).toBe(header);
});

it.each([
  ['by name', 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;', `a & b <c> "d" 'e'`],
  ['by number', 'a&#39;b&#x27;c&#X27;d&#x000027;e', "a'b'c'd'e"],
  ['past the basic plane', '&#1048576;&#x100000;', '\u{100000}\u{100000}'],
  ['once only', '&amp;#39;', '&#39;'],
  ['leaving what no character is', '&#1114112;&#xFFFFFFFF;', '&#1114112;&#xFFFFFFFF;'],
])('decodes XML %s', (_, xml, text) => {
  expect(unescapeXml(xml)).toBe(text);
});
