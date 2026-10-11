# 產生佔位用 BGM / 音效（正式素材請直接換掉 assets/bgm、assets/se 內的檔案）
import wave, struct, math, os
R = 22050
def note(freq, dur, vol=0.25):
    n = int(R * dur)
    return [vol * math.sin(2*math.pi*freq*i/R) * math.exp(-3.0*i/n) * min(1, i/200) for i in range(n)]
def write(path, samples):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(R)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s))*32767)) for s in samples))
def loop(notes, step):
    out = []
    for f in notes: out += note(f, step)
    return out
os.makedirs('assets/bgm', exist_ok=True); os.makedirs('assets/se', exist_ok=True)
write('assets/bgm/night.wav', loop([220,262,330,392,330,262,196,262, 220,262,330,392,440,392,330,262], 0.5))
write('assets/bgm/tense.wav', loop([147,156,147,156,131,139,131,139, 147,156,147,156,175,165,147,139], 0.5))
write('assets/se/ding.wav', note(880, 0.6, 0.4))
