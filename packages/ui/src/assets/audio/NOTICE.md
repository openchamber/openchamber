Notification cue sounds
=======================

The 45 `.aac` clips in this directory are vendored, unmodified, from
upstream opencode's attention sound pack:

    source:   https://github.com/sst/opencode
    path:     packages/ui/src/assets/audio/*.aac
    commit:   b471c2b4495747353af768fbf2e0790c9d820ce2
    license:  MIT — Copyright (c) 2025 opencode

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to permit
    persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
    SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Packs: `yup`, `nope`, `staplebops`, `bip-bop`, `alert`.

To replace or extend the set, add clips here and add the pack to
`SOUND_PACK_SIZES` in `packages/ui/src/lib/notificationSound.ts`. A file whose
id is not in that list is ignored, so a stray clip cannot take over a sound.
