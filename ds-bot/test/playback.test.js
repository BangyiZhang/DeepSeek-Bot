import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback } from '../src/client/playback.js'
import { turnDetector } from '../src/client/speech.js'

test('local playback falls back once and ignores callbacks after stopping', async () => {
  const spoken = []
  let audio
  let finished = 0
  class Audio {
    constructor(url) { this.url = url; audio = this }
    play() { return Promise.reject(new Error('offline')) }
    pause() {}
  }
  const playback = createPlayback({ endpoint: 'http://127.0.0.1:55069/tts', Audio,
    synthesis: { cancel() {}, getVoices: () => [], speak: value => spoken.push(value) },
    Utterance: class { constructor(text) { this.text = text } }, done: () => finished++,
  })
  playback.speak('Hello & goodbye')
  const failed = audio.onerror
  await new Promise(resolve => setImmediate(resolve))
  failed()
  assert.equal(spoken.length, 1)
  assert.equal(new URL(audio.url).searchParams.get('text'), 'Hello & goodbye')
  playback.stop()
  spoken[0].onend()
  assert.equal(finished, 0)
})

test('adaptive silence detection starts at time zero and ends after a bounded pause', () => {
  const detect = turnDetector()
  assert.equal(detect(0.5, 0), 'speech')
  assert.equal(detect(0.01, 100), 'speech')
  assert.equal(detect(0.01, 800), 'done')
  const noise = turnDetector()
  for (let now = 0; now < 1000; now += 10) assert.equal(noise(0.04, now), 'waiting')
})
