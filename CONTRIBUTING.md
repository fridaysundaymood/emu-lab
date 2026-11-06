# Contributing

Use Node 24 and JDK 21. Install dependencies with `npm install`; run `npm run lint`, `npm run build`, and `npm test`. Tests must use synthetic data and must never operate on user-owned emulators. Integration tests require a locally installed Android SDK and hardware acceleration. Create only an `ak-emu-lab-*` AVD and remove it after the test. Never commit credentials, device console tokens, absolute workstation paths, or application data.
