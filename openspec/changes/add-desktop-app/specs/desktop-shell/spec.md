## ADDED Requirements

### Requirement: Installable app for Windows and macOS
The app SHALL install from a signed installer (NSIS on Windows 10 22H2+, notarized DMG on macOS 13+) downloaded from CustomerPro, and SHALL update itself from the CustomerPro release channel, installing on the next restart. When CustomerPro reports a minimum version above the installed one, the app SHALL ask to update before any online action.

#### Scenario: Update available
- **WHEN** a newer stable release is published
- **THEN** the app downloads it in the background, verifies its signature, and offers "Restart to update"

#### Scenario: Below minimum version
- **WHEN** `/me` returns a minimum version above the installed version
- **THEN** sync, the AI and publishing are blocked with an "Update to continue" screen, and local editing still works

### Requirement: Projects are folders on the owner's computer
Each project SHALL be a folder holding the project file, prepared media, voiceover, music, the analysis cache, the director log and renders. Sources in the project file SHALL be relative paths. Raw footage SHALL be referenced in place and never copied or uploaded.

#### Scenario: Raw file moved
- **WHEN** a raw clip referenced by a project is moved or deleted
- **THEN** the media bin marks it missing with "Locate…", and segments already prepared from it keep working

### Requirement: The Studio editor inside the app
The app SHALL open a project in the same DT.ly Studio used by the CustomerPro web app, served locally, and SHALL show changes made by the AI director live while the owner watches.

#### Scenario: Director edits while Studio is open
- **WHEN** the director adds a title block
- **THEN** it appears in Studio's timeline and viewer within a second, without a reload

### Requirement: Safe local surface
The local editor server SHALL listen only on 127.0.0.1 with a per-launch token. The app SHALL hold no AI provider keys. The CustomerPro token SHALL be stored in the OS keychain. Renderer windows SHALL run without Node access.

#### Scenario: Another program probes the port
- **WHEN** a request reaches the local server without the launch token
- **THEN** it is refused with 403
