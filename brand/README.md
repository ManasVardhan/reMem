# reMem brand

Black and white only. Two typefaces: Instrument Serif for names and figures,
IBM Plex Mono for labels, paths and data.

## Tokens

| Token   | Light     | Dark      |
| ------- | --------- | --------- |
| `ink`   | `#111114` | `#F2F2EF` |
| `paper` | `#FBFBF9` | `#0D0D0F` |
| `plate` | `#FFFFFF` | `#141416` |
| `rule`  | `#E4E4E0` | `#2A2A2E` |
| `mute`  | `#8C8C86` | `#7E7E86` |

## The mark

Two squares on a 96-unit grid, offset by half their width, with the overlap
knocked out by an even-odd fill. The newer square sits over the older one and
the older one is still there: the kernel supersedes, it does not delete.

- `remem-mark.svg` - ink on transparent
- `remem-mark-inverse.svg` - paper on transparent, for dark grounds
- `remem-mark-currentcolor.svg` - inherits `color`, for inline use
- `remem-mark-{16,32,64,128,256,512,1024}.png`

Below 32px the knockout closes up, so use the 16px raster rather than scaling
the SVG down.

## Banners

`banner.html` is the source; the PNGs are rendered from it at 2x.

- `remem-banner.png` (2560x1280) - GitHub social preview
- `remem-banner-wide.png` (2560x760) - README header

To re-render, serve this directory and screenshot both sizes:

```sh
cd brand
sed 's/height: 640px/height: 380px/; s/padding: 76px 88px/padding: 52px 72px/; \
     s/font-size: 104px/font-size: 82px/; s/width: 132px/width: 104px/; \
     s/height: 132px/height: 104px/; s/font-size: 25px/font-size: 21px/' \
  banner.html > banner-wide.html
python3 -m http.server 8791 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,640 --screenshot=remem-banner.png http://localhost:8791/banner.html
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,380 --screenshot=remem-banner-wide.png http://localhost:8791/banner-wide.html
```

ImageMagick cannot substitute here: the bundled build has no Freetype and will
not render text.

## Where else this shows up

The live viewer (`src/viewer/page.ts`) is built on the same tokens, the same two
typefaces, and the same hairline plate grid.
