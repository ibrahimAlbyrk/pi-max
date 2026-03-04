# Custom Statusline Extension

Varsayilan pi footer'ini tek satirlik, bilgi yogun bir statusline ile degistirir.

## Kurulum

`.pi/extensions/custom-statusline.ts` konumuna yerlestirin. Otomatik yuklenir.

## Ozellikler

- **Token takibi**: Input, output ve cache token sayilarini gosterir
- **Git durumu**: Degistirilmis dosya sayisini izler
- **Context kullanimi**: Yuzde gostergesi ve elmas ilerleme cubugu
- **Model bilgisi**: Kisaltilmis model adi ve thinking seviyesi gostergesi
- **Maliyet takibi**: Oturum basina harcanan tutari gosterir
- **ANSI 256 renk destegi**: Claude Code tasarimina uygun stil

## Gorunum

```
 GPT4o │ T:min │ ◆◆◆◇◇ 58% │ ↑1.2k ↓340 ⚡120 │ $0.05 │ git:3M
```

Icerik soldan saga:
| Alan | Aciklama |
|------|----------|
| Model | Kisaltilmis model adi |
| Thinking | Thinking seviyesi (T:min, T:med, vb.) |
| Context | Elmas cubuk + yuzde |
| Tokens | Input (↑), output (↓), cache (⚡) |
| Cost | Oturum maliyeti |
| Git | Degistirilen dosya sayisi |

## Hook'lar

| Hook | Islem |
|------|-------|
| `session_start` | Baslangic durumunu yukler |
| `turn_end` | Token/maliyet bilgilerini gunceller |
| `session_switch` | Oturum degistiginde sifirlar |
| `model_select` | Model bilgisini gunceller |

## Yapilandirma

Renkler extension icerisindeki `theme` nesnesi uzerinden degistirilebilir. ANSI 256 renk kodlari kullanilir.

## Faydalar

- Ekran alanini verimli kullanir — tum onemli bilgiler tek satirda
- Git ve token durumunu anlik takip etmeyi saglar
- Maliyet kontrolunu kolaylastirir
