# Third-party notices

Ghosttea incorporates and interoperates with third-party software. The
following notice covers the upstream terminal core distributed with Ghosttea.
Rust and npm dependencies retain their own license metadata in their source
distributions and package registries.

## Ghostty

Source: <https://github.com/ghostty-org/ghostty>

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Ghostty is licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The exact upstream revision used by Ghosttea is recorded in
`native/ghostty.lock.json`.

## Ghostty color-theme catalog

Source: <https://github.com/mbadolato/iTerm2-Color-Schemes>

Pinned revision: `875a82f0fdc773ae45099ce683a11c56bb0f8b3d`

The catalog collection is MIT licensed, copyright 2011 to present Mark
Badolato. The upstream notice states that copyright and licensing for each
individual theme remain with that theme's author. Ghosttea preserves theme
names and records the source revision in the generated catalog.

## Ghostty shader adaptations

Source collection: <https://github.com/0xhckr/ghostty-shaders>

Reviewed revision: `85898f08fcf4a9274e418912098e99e00a5f8350`

Only files with explicit per-file terms are eligible for new bundled ports.
The settings UI identifies the other upstream shaders as unavailable pending
redistribution clearance.

### CRT

The `crt.glsl` effect is based on Timothy Lottes' CRT-styled scalar and the
Ghostty adaptation by Qwerasd. The upstream file is dedicated to the public
domain under the Unlicense.

### Sparks from Fire

The ember effect is adapted from Jan Mróz's shader, with the Ghostty adaptation
credited to Alex Sherwin. The upstream file is licensed under CC BY 3.0.

### VHS

Copyright (c) 2026 Alex Brinsmead

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Better CRT compatibility effect

Ghosttea's pre-existing `better-crt` compatibility effect traces to a
Shadertoy work distributed under CC BY-NC-SA 3.0 and later modifications by
April Hall. It is retained and clearly labeled as a legacy non-commercial
effect; it is not evidence that the other unlicensed or non-commercial files
in the source collection may be redistributed.
