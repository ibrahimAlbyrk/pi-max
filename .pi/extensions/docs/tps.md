# TPS (Tokens Per Second) Extension

Her agent calistirmasinin ardindan token uretim hizini ve kullanim metriklerini gosteren extension.

## Kurulum

`.pi/extensions/tps.ts` konumuna yerlestirin. Otomatik yuklenir.

## Kullanim

Ek bir islem gerekmez. Agent her calistiktan sonra bildirim olarak metrikler gosterilir.

## Ozellikler

- **Token/saniye hesaplama**: Agent calisma suresi boyunca uretilen token hizini olcer
- **Token sayimi toplama**: Input, output, cache okuma/yazma ve toplam token sayilarini gosterir
- **Sure gosterimi**: Agent calisma suresini gosterir
- **Arac cagrisi ozeti**: Kullanilan tool sayisini gosterir

## Bildirim Formati

```
TPS 42.5 tok/s. out 425, in 150, cache r/w 0/100, total 575, 10.0s
```

| Alan | Aciklama |
|------|----------|
| TPS | Saniyedeki token sayisi |
| out | Uretilen (output) token |
| in | Girdi (input) token |
| cache r/w | Cache okuma / yazma token |
| total | Toplam token |
| sure | Gecen sure (saniye) |

## Hook'lar

| Hook | Islem |
|------|-------|
| `agent_start` | Zamanlayiciyi baslatir, sayaclari sifirlar |
| `agent_end` | Metrikleri hesaplar ve bildirim gosterir |
| `tool_call` | Tool cagrisi sayacini arttirir |

## Faydalar

- Model performansini karsilastirmak icin somut metrikler sunar
- Token tuketimini takip ederek maliyet kontrolu saglar
- Yavas calismalari tespit etmenize yardimci olur
