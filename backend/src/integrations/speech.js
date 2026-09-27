// Speech in and out (Krish lane). Contract: docs/CONTRACTS.md §1 "Speech".
//
//   transcribe(buffer, mime, languageHint?) -> Promise<string | null>   // null = ask the patient to type
//   tts(text, language)                     -> Promise<{ url } | { buffer, mime } | null>
//
// Both are optional extras: no key, no network or a bad response returns null and
// the channel falls back to text. Nothing here ever throws to the caller.
import googleTTS from 'google-tts-api';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';
const TIMEOUT_MS = 20_000;

// Whisper rejects unknown file extensions, so name the upload after its type.
const EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/x-m4a': 'm4a' };

export const transcriptionEnabled = () => Boolean(process.env.GROQ_API_KEY);

export async function transcribe(buffer, mime = 'audio/ogg', languageHint) {
  const key = process.env.GROQ_API_KEY;
  if (!key || !buffer?.length) return null;
  const type = mime.split(';')[0].trim();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `voice.${EXT[type] ?? 'ogg'}`);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'json');
  // A hint helps short, accented clips; Whisper still copes if the patient switches language.
  if (languageHint && /^[a-z]{2}$/.test(languageHint)) form.append('language', languageHint);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[speech] groq transcription failed: HTTP ${res.status}`);
      return null;
    }
    const text = (await res.json())?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('[speech] groq transcription failed:', err.message);
    return null;
  }
}

// Google Translate voices use a few codes that differ from ours.
const TTS_LANG = { zh: 'zh-CN', pt: 'pt-BR', tl: 'fil' };
export const ttsLang = (language) => TTS_LANG[language] ?? language ?? 'en';

// Emojis get read aloud as their names ("red circle") or break the voice, so drop them.
export const speakable = (text) =>
  String(text ?? '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();

const MAX_CHUNK = 200; // google-tts-api's limit for a single URL

// Short text: a URL Telegram can fetch itself (no network from us).
// Long text: the chunks are downloaded and joined into one MP3 (MP3 frames concatenate cleanly).
export async function tts(text, language = 'en') {
  const clean = speakable(text);
  if (!clean) return null;
  const lang = ttsLang(language);
  try {
    if (clean.length <= MAX_CHUNK) return { url: googleTTS.getAudioUrl(clean, { lang, slow: true }) };
    const parts = googleTTS.getAllAudioUrls(clean, { lang, slow: true });
    const buffers = [];
    for (const { url } of parts) {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffers.push(Buffer.from(await res.arrayBuffer()));
    }
    return { buffer: Buffer.concat(buffers), mime: 'audio/mpeg' };
  } catch (err) {
    console.error('[speech] tts failed:', err.message);
    return null;
  }
}
