export function createPlayback({ endpoint, Audio, synthesis, Utterance, done }) {
  let audio
  let generation = 0
  const stop = () => {
    generation += 1
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio = void 0
    }
    synthesis?.cancel()
  }
  return {
    stop,
    speak(text) {
      stop()
      const own = generation
      const finish = () => {
        if (own === generation) done()
      }
      let fallbackStarted = false
      const fallback = () => {
        if (own !== generation || fallbackStarted) return
        fallbackStarted = true
        if (audio) {
          audio.onended = null
          audio.onerror = null
          audio.pause()
          audio = void 0
        }
        if (!synthesis || !Utterance) {
          finish()
          return
        }
        const utterance = new Utterance(text)
        const chinese = /[\u3400-\u9fff]/.test(text)
        utterance.lang = chinese ? "zh-CN" : "en-US"
        const voices = synthesis.getVoices()
        const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(chinese ? "zh" : "en"))
        const selected = matching.find((voice) => /Tingting|Meijia/.test(voice.name)) ?? matching[0]
        if (selected) utterance.voice = selected
        utterance.onend = finish
        utterance.onerror = finish
        synthesis.speak(utterance)
      }
      if (!endpoint || !Audio) {
        fallback()
        return
      }
      try {
        const url = new URL(endpoint)
        if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
          fallback()
          return
        }
        url.searchParams.set("text", text)
        audio = new Audio(url.href)
        audio.onended = finish
        audio.onerror = fallback
        void Promise.resolve(audio.play()).catch(fallback)
      } catch {
        fallback()
      }
    }
  }
}
