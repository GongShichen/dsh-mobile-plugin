# Third-party components

Original plugin code is MIT licensed. Distributed dependencies retain their own licenses and bundled notices.

| Component | License |
|---|---|
| @number0/iroh / iroh-ffi | MIT OR Apache-2.0 |
| @napi-rs/keyring | MIT |
| @deepseek-ai/cordis, @deepseek-ai/schemastery | MIT |
| qrcode | MIT |
| google-auth-library | Apache-2.0 |
| React (provided by the DSH client) | MIT |

Exact versions and transitive dependencies are recorded in `pnpm-lock.yaml`. The plugin browser bundle includes qrcode; its license is reproduced in `licenses/qrcode.txt`. iroh and Keychain binaries are installed as dependencies and retain their package license files.

- DeepSeek Harness turn-usage accounting, pinned ce7073d51254c26cd63b22a60835b8f948deb447: MIT, copyright 2026 DeepSeek. The desktop adaptation retains the Web algorithm; license in `licenses/deepseek-MIT.txt`.
