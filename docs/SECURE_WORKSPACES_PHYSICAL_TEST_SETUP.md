# Secure Workspaces: guided тестування на цільових платформах

Цей runbook відкривається в OpenChamber-сесії безпосередньо на Windows, Linux або macOS host. Assistant виконує діагностику, build, provider setup, перевірки та cleanup у локальному checkout; operator підтверджує UAC, reboot, системні діалоги й ручні UI-кроки. Self-hosted GitHub runner для цього процесу не потрібен.

Це внутрішня live validation поточного кандидата. Вона стає release evidence лише після окремого рішення та запису exact commit, package, image і compatibility identities у `SECURE_WORKSPACES_SPECIFICATION.md`.

## 1. Test model

Рівні перевірки не взаємозамінні:

1. CI перевіряє build, unit/integration tests, packaged startup, iOS Simulator та Android Emulator.
2. Guided target-host session перевіряє реальний packaged app, OS integration, provider lifecycle і cleanup на конкретній машині.
3. Physical mobile run перевіряє exact TestFlight build або signed APK на реальному пристрої.
4. Interactive apply перевіряє, що workspace change не змінює host до approval, а reviewed selection застосовується атомарно й точно.

Simulator, emulator, fixture, VM або unpacked package smoke не можна називати physical/live platform evidence. Один native artifact достатньо побудувати й встановити один раз на платформу, якщо його identity і bytes не змінилися.

## 2. Обов'язкові правила безпеки

- Використовувати disposable project, окремий local OS test user за можливості та ізольовані OpenChamber, Chromium, OpenCode, Docker і kubeconfig profiles.
- Не надсилати passwords, Apple ID/TestFlight credentials, passkey secrets, signing keys, bearer tokens, pairing URLs або device serial/UDID.
- Не використовувати personal project або звичайний OpenChamber profile для destructive lifecycle/apply tests.
- Runtime і gateway мають бути exact digest references; `latest` і tag-only references заборонені.
- Assistant не обходить UAC, reboot, device trust, passkey або destructive confirmation. Ці дії виконує operator локально.
- Pairing URL одноразовий, окремий для кожного device run і не потрапляє в command output, screenshots чи artifacts.
- Cleanup є частиною pass criteria. Cleanup failure лишається явним failure; ресурси не видаляються за name heuristics без authoritative ownership.
- Screenshots і logs мають бути sanitized: без hostname, username, personal paths, source content, credentials і device IDs.

## 3. Перед кожною сесією

1. Відкрити exact candidate branch у новій OpenChamber-сесії на target host.
2. Переконатися, що checkout не містить personal secrets і не використовує production project.
3. Записати локально commit SHA, package version, architecture, plugin pin, SDK/OpenCode versions і exact runtime/gateway digests.
4. Створити disposable project із known baseline content і hash.
5. Створити isolated app/data/config directories поза personal profile.
6. Перевірити доступний disk/RAM і provider prerequisites.
7. Узгодити з operator, які кроки вимагатимуть UAC, reboot, GUI clicks або підключення пристрою.

Не починати provider validation, якщо current runtime/gateway digests ще не опубліковані або compatibility matrix не визначена. У такому разі можна завершити platform setup і package smoke, але результат не є provider certification.

## 4. Загальна acceptance matrix

Кожний desktop host перевіряє:

- exact native package та architecture;
- startup реального packaged executable з isolated profiles;
- bundled OpenCode CLI і exact pinned workspace plugin payload;
- in-process OpenChamber server і renderer readiness;
- provider validation, create, routed ordinary session, restart/reconcile, export і cleanup;
- authenticated HTTP, SSE і WebSocket paths, де вони входять у сценарій;
- host project unchanged before reviewed apply;
- file/hunk selection, dry-run, confirmation, exact atomic apply і post-apply content;
- no unrelated host changes або owned provider resources after cleanup;
- explicit failure/recovery result for interrupted create, app restart і cleanup retry.

Provider coverage:

| Host | Required coverage |
| --- | --- |
| Windows | Packaged NSIS app, Docker Desktop Linux containers, focused Kubernetes integration |
| Linux | Native AppImage, full Docker lifecycle, full disposable `kind` lifecycle |
| macOS | Packaged app, Docker/Colima as selected, Kubernetes where applicable, Apple Container |
| iOS | Exact TestFlight build connected to a disposable Windows/Linux OpenChamber server |
| Android | Exact signed APK connected to a disposable Windows/Linux OpenChamber server |

## 5. Windows target host

Відома internal-test машина: `AZW MINI S`, Windows 10 Home, `AMD64`; Docker ще не встановлений. Windows 10 придатний для functional validation, але в 2026 році не є production platform certification. Windows 11 рекомендований, якщо hardware підтримує upgrade.

### 5.1 Діагностика

Assistant запускає в PowerShell:

```powershell
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture,CsProcessors,CsTotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions
Get-Tpm | Select-Object TpmPresent,TpmReady,ManufacturerVersion
Confirm-SecureBootUEFI
wsl --status
Get-Volume -DriveLetter C | Select-Object Size,SizeRemaining
```

Рекомендовано 16 GB RAM і 40-60 GB вільного disk. 8 GB може бути достатньо для Docker-only run, але `kind` краще перенести на Linux.

### 5.2 Одноразова підготовка

Operator підтверджує BIOS/UEFI, UAC і reboot для:

1. Hardware virtualization і SLAT.
2. WSL2 через `wsl --install`.
3. Docker Desktop x86-64 із WSL2 engine та Linux containers.
4. Першого Docker Desktop startup/license prompt.

Після reboot assistant перевіряє:

```powershell
docker version
docker info
docker run --rm hello-world
```

### 5.3 Windows run

1. Install dependencies із frozen lockfile та запустити package-scoped checks.
2. Побудувати native Windows package через `bun run electron:build`.
3. Запустити exact installer/package в isolated profile; не використовувати іншу встановлену OpenChamber copy.
4. Виконати Docker acceptance matrix та interactive apply.
5. Виконати focused Kubernetes paths/process-spawning/`kubectl` integration. За достатніх ресурсів використати disposable local `kind`; інакше підключити окремий test cluster на Linux через isolated kubeconfig.
6. Перевірити hidden process spawning, cancellation/process-tree termination, path handling і cleanup.
7. Видалити test app/profile/project і тільки ownership-verified Docker/Kubernetes resources.

## 6. Linux target host

Потрібні native x64 або arm64 host, graphical session, Docker Engine/Desktop, FUSE/libfuse2 для direct AppImage launch і достатньо ресурсів для disposable `kind`.

```bash
uname -a
uname -m
docker version
docker info
printf '%s\n' "${XDG_SESSION_TYPE:-}" "${DISPLAY:-}" "${WAYLAND_DISPLAY:-}"
```

Guided run:

1. Install dependencies із frozen lockfile і виконати package-scoped checks.
2. Встановити checksum-pinned `kubectl` і `kind`, якщо вони відсутні.
3. Побудувати native AppImage через `OPENCHAMBER_TARGET_ARCH=<x64|arm64> bun run electron:build`.
4. Виконати `bun run --cwd packages/electron verify:linux-appimage`.
5. Запустити exact AppImage напряму з writable path у graphical session. `APPIMAGE_EXTRACT_AND_RUN=1` можна використовувати лише для діагностики, не як direct-AppImage evidence.
6. Виконати повний Docker lifecycle/networking/recovery/apply matrix.
7. Створити disposable `kind` cluster з NetworkPolicy-capable CNI та виконати Kubernetes ownership, RBAC denial, managed egress/direct-egress denial, restart/reconcile, export/apply і cleanup matrix.
8. Перевірити AppImage update identity та actionable behavior для read-only/missing `APPIMAGE`.
9. Видалити disposable cluster, profiles і project; підтвердити відсутність owned containers, networks, volumes, namespace/PVC/Secrets.

## 7. macOS та Apple Container

Використати supported macOS/hardware, exact native package, Apple Container CLI та окремі isolated profiles. Docker provider явно використовує Docker Desktop або Colima; Kubernetes використовує disposable `kind`.

Apple Container run має покривати host-only networking, external egress, authenticated transport, collision, export/apply, system stop/start, reconciliation і cleanup. Managed gateway egress зараз fail-closed blocker: current Apple Container CLI не має isolation-capable multi-network primitive для gateway-only egress без direct outbound. Не позначати цей gate як passed і не послаблювати policy для тесту.

## 8. Mobile devices

Mobile app не містить OpenChamber server. Для physical run вона підключається до disposable backend, уже перевіреного на Windows або Linux, з isolated test project і provider policy.

### 8.1 iPhone через TestFlight

- `.github/workflows/mobile-release.yml` будує iOS на GitHub-hosted macOS і завантажує IPA в App Store Connect.
- App Store Connect використовує окрему test group тільки для designated operator; automatic distribution іншим groups вимкнена.
- Operator чекає processing, встановлює exact version/build через TestFlight і локально підтверджує trust/passkey prompts.
- Mac із Xcode `devicectl` та Maestro може запустити `bun run --cwd packages/mobile smoke:physical:ios`; helper перевіряє exact installed identity і не логує UDID/pairing URL.

### 8.2 Android APK

- `.github/workflows/mobile-release.yml` будує signed APK/AAB; APK artifact доставляється operator без self-hosted runner.
- Host потребує Java 21, `adb`, `apksigner`, Maestro та рівно один authorized physical device.
- Перед install перевірити signature validity, expected certificate digest, exact version/build.
- `bun run --cwd packages/mobile smoke:physical:android` встановлює і запускає candidate без логування serial/pairing URL.

Для обох платформ `.maestro/secure-workspace-physical.yaml` покриває routed session/change/export dry-run, а `.maestro/secure-workspace-cleanup.yaml` виконує cleanup. Maestro flow не замінює ручний interactive apply до host project.

## 9. Interactive apply

1. Зафіксувати baseline hash disposable host project.
2. Створити або reuse Secure Workspace через звичайний UI flow і підтвердити routed session.
3. Усередині workspace зробити deterministic change без model credentials, наприклад створити `openchamber-guided-e2e.txt` з exact agreed content.
4. До export/apply незалежно підтвердити, що host project і baseline hash не змінилися.
5. Operator відкриває `Review changes`, перевіряє diff, виконує file/hunk selection і `Check changes` dry-run.
6. Operator явно підтверджує `Apply changes`.
7. Assistant перевіряє exact host bytes/mode та відсутність unselected або unrelated changes.
8. Повторити negative path із concurrent host edit і підтвердити conflict без partial mutation.
9. Видалити artifact/workspace і перевірити provider cleanup.

## 10. Failure та recovery

При failure:

1. Не маскувати failure повторним create або authoritative-empty result.
2. Зберегти sanitized command/error output та exact candidate identities.
3. Закрити app тільки якщо це не знищить потрібний crash-recovery state.
4. Перезапустити OpenChamber і виконати authoritative reconciliation.
5. Видаляти лише ownership-verified resources.
6. Retry cleanup окремо та записати retained/unresolved resources.
7. Rotate/revoke невикористану pairing session; одноразовий URL не reuse.
8. Після діагностики видалити disposable project, profiles і cluster.

## 11. Що записати після run

Дозволено записати commit SHA, versions/builds, package SHA-256, platform/architecture, plugin pin, exact image digests, test result, sanitized screenshots/logs і cleanup result. Не записувати credentials, signing private keys, pairing URLs, device IDs, machine/user names, personal paths або source content.

Підсумок має окремо позначати automated checks, packaged target-host validation, physical mobile validation, interactive apply та unresolved blockers. До current exact compatibility/image matrix і всіх required platform gates не використовувати формулювання `production-ready` або `release certified`.

## 12. Optional future automation

Після кількох стабільних guided runs повторювані bootstrap, verify і cleanup commands можна винести в local scripts. Scripts мають залишатися локальними, idempotent, redacted і ownership-aware. Self-hosted runner workflow додається лише за окремою потребою; він не є prerequisite для platform validation або release delivery.
