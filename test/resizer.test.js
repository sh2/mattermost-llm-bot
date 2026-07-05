import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_LONG_EDGE,
  OUTPUT_BACKGROUND,
  OUTPUT_MIME_TYPE,
  OUTPUT_QUALITY,
  resizeImageToMaxLongEdge,
} from '../src/images/resizer.js';

function createSharpStub(result = Buffer.from('resized-output')) {
  const calls = [];
  const instance = {
    resize(options) {
      calls.push(['resize', options]);
      return instance;
    },
    flatten(options) {
      calls.push(['flatten', options]);
      return instance;
    },
    jpeg(options) {
      calls.push(['jpeg', options]);
      return instance;
    },
    async toBuffer() {
      calls.push(['toBuffer']);
      return result;
    },
  };

  return {
    calls,
    sharpImpl(bytes) {
      calls.push(['sharp', bytes]);
      return instance;
    },
  };
}

test('resizeImageToMaxLongEdge calls sharp with resize, flatten, jpeg, and toBuffer', async () => {
  const { calls, sharpImpl } = createSharpStub();
  const bytes = Buffer.from('input-image');

  await resizeImageToMaxLongEdge(bytes, 1024, sharpImpl);

  assert.deepEqual(calls, [
    ['sharp', bytes],
    [
      'resize',
      {
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
      },
    ],
    ['flatten', { background: '#ffffff' }],
    ['jpeg', { quality: 80 }],
    ['toBuffer'],
  ]);
});

test('resizeImageToMaxLongEdge uses the default max long edge when omitted', async () => {
  const { calls, sharpImpl } = createSharpStub();

  await resizeImageToMaxLongEdge(Buffer.from('input-image'), undefined, sharpImpl);

  assert.deepEqual(calls[1], [
    'resize',
    {
      width: DEFAULT_MAX_LONG_EDGE,
      height: DEFAULT_MAX_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    },
  ]);
});

test('resizeImageToMaxLongEdge exports the fixed JPEG output settings', () => {
  assert.equal(OUTPUT_MIME_TYPE, 'image/jpeg');
  assert.equal(OUTPUT_QUALITY, 80);
  assert.equal(OUTPUT_BACKGROUND, '#ffffff');
});

test('resizeImageToMaxLongEdge returns bytes and mimeType together', async () => {
  const outputBytes = Buffer.from('jpeg-output');
  const { sharpImpl } = createSharpStub(outputBytes);

  const result = await resizeImageToMaxLongEdge(Buffer.from('input-image'), 512, sharpImpl);

  assert.deepEqual(result, {
    bytes: outputBytes,
    mimeType: OUTPUT_MIME_TYPE,
  });
});
