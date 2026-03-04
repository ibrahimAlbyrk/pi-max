# Image Generation Extension

Birden fazla AI saglayicisi kullanarak gorsel uretme ve duzenleme yetenegi saglayan extension.

## Kurulum

`.pi/extensions/image-generation/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Kullanim

Agent tarafindan tool olarak kullanilir:

```
generate_image("A sunset over mountains", "output/sunset.png")
edit_image("Make the sky more dramatic", "input.png", "output.png")
```

## Saglayicilar

| Saglayici | Model | Fiyat/gorsel | Ozellik |
|-----------|-------|-------------|---------|
| Google Gemini | Nano Banana 2 | $0.045–$0.151 | Hizli, 14 referans gorsel destegi |
| OpenAI | gpt-image-1 | $0.080 | En yuksek kalite |
| FLUX Pro | fal.ai | $0.050 | Hizli, img2img duzenleme |
| Stability AI | SD3.5 | $0.065 | Search-replace duzenleme |

## Tool'lar

### `generate_image`

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `prompt` | string | Evet | Gorsel aciklamasi |
| `output_path` | string | Evet | Kayit yolu |
| `provider` | string | Hayir | Saglayici (gemini/openai/flux/stability) |
| `aspect_ratio` | string | Hayir | En-boy orani (1:1, 16:9, 4:3, vb.) |
| `size` | string | Hayir | Boyut (512px, 1K, 2K, 4K) |

### `edit_image`

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `prompt` | string | Evet | Duzenleme talimati |
| `image_path` | string | Evet | Kaynak gorsel yolu |
| `output_path` | string | Hayir | Cikti yolu (bos ise kaynak uzerine yazar) |
| `reference_images` | string[] | Hayir | Ek referans gorselleri (max 14) |
| `provider` | string | Hayir | Saglayici |

## Saglayici Secimi

Otomatik tespit sirasi (API key'e gore):

1. Gemini (`GEMINI_API_KEY` veya `GOOGLE_API_KEY`)
2. OpenAI (`OPENAI_API_KEY`)
3. FLUX (`FAL_KEY`)
4. Stability (`STABILITY_API_KEY`)

Manuel override:
- `PI_IMAGE_PROVIDER` env var
- Tool parametresinde `provider` belirtme

## Butce Yonetimi

### Yapilandirma

`~/.pi/agent/extensions/image-generation.json` veya `.pi/extensions/image-generation.json`:

```json
{
  "budgetLimit": 5.0,
  "budgetWarning": 3.0
}
```

| Alan | Aciklama |
|------|----------|
| `budgetLimit` | Maksimum harcama ($). Asildiginda uretim engellenir |
| `budgetWarning` | Uyari esigi ($) |

## Faydalar

- Birden fazla AI gorsel saglayicisini tek arayuzden kullanabilirsiniz
- Butce kontrolu ile beklenmedik maliyetleri onlersiniz
- Gorsel duzenleme ile mevcut gorselleri iyilestirebilirsiniz
- Saglayici otomatik tespiti sayesinde yapilandirma minimumdur
