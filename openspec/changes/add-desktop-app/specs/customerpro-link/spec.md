## ADDED Requirements

### Requirement: Sign in with CustomerPro
The app SHALL sign in with a device code that the owner approves on customerpro.in, choosing the workspace. Access SHALL follow the workspace's plan and the user's Video permissions, and the device SHALL be revocable from Settings → Devices.

#### Scenario: Plan without the Video app
- **WHEN** the workspace's plan does not include Video
- **THEN** the app shows what Video includes and an "Upgrade on CustomerPro" link, and opens no project

#### Scenario: Device revoked
- **WHEN** the owner revokes the device on the web
- **THEN** the app's next online action signs it out, and local projects stay on disk

### Requirement: One project on web and desktop
A linked project SHALL sync its project file with CustomerPro using revisions, pushing on save and pulling on open. When both sides changed, the app SHALL keep both: load the latest, or keep the local copy as a new project. Prepared media SHALL upload only on publish or when the owner chooses to edit on the web too.

#### Scenario: Edited on the web while the app was closed
- **WHEN** a teammate changed the project on the web and the owner opens it on the desktop
- **THEN** the desktop loads the web version, and its prepared media is still found locally

#### Scenario: Open from the web
- **WHEN** the owner clicks "Open in desktop app" on a project page
- **THEN** the app opens that project, downloading the project file and any missing media
