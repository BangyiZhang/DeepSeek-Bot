import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPlayback } from '../src/client/playback.js'

function fixture(endpoint, play = () => Promise.resolve()) {
  const audio = []
  const spoken = []
  let finished = 0
  class FakeAudio {
    constructor(url) { this.url = url; audio.push(this) }
    play = play
    pause() { this.paused = true }
  }
  const synthesis = { cancel() {}, getVoices: () => [{ lang: 'en-US', name: 'English' }, { lang: 'zh-CN', name: 'Tingting' }], speak: value => spoken.push(value) }
  const playback = createPlayback({ endpoint, Audio: FakeAudio, synthesis, Utterance: class { constructor(text) { this.text = text } }, done: () => { finished += 1 } })
  return { playback, audio, spoken, get finished() { return finished } }
}

test('local TTS receives encoded speech and returns to listening after audio ends', () => {
  const f = fixture('http://127.0.0.1:12345/speak?voice=sample')
  f.playback.speak('中文 & another phrase')
  const url = new URL(f.audio[0].url)
  assert.equal(url.searchParams.get('text'), '中文 & another phrase')
  assert.equal(url.searchParams.get('voice'), 'sample')
  f.audio[0].onended()
  assert.equal(f.finished, 1)
  assert.equal(f.spoken.length, 0)
})

test('an absent or non-local TTS URL falls back to a matching system voice', () => {
  for (const url of [null, 'https://example.com/tts', 'file:///tmp/speech', 'http://user:pass@localhost/tts']) {
    const f = fixture(url)
    f.playback.speak('你好')
    assert.equal(f.audio.length, 0)
    assert.equal(f.spoken[0].voice.name, 'Tingting')
    f.spoken[0].onend()
    assert.equal(f.finished, 1)
  }
})

test('local audio failure falls back only once and stop discards late callbacks', async () => {
  const f = fixture('http://localhost:12345/tts', () => Promise.reject(new Error('Mock unavailable')))
  f.playback.speak('Hello')
  const failed = f.audio[0].onerror
  failed()
  await Promise.resolve()
  assert.equal(f.spoken.length, 1)
  const ended = f.spoken[0].onend
  f.playback.stop()
  ended()
  assert.equal(f.finished, 0)
  assert.equal(f.audio[0].paused, true)
})
