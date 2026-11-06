## ADDED Requirements

### Requirement: Import footage in place
The owner SHALL be able to add files or whole folders (video, photos, audio, PDF). The app SHALL read each file's codec, resolution, frame rate, rotation, duration and audio, make a thumbnail, and identify it by a content hash, without copying raw video.

#### Scenario: Drone folder
- **WHEN** the owner adds a folder of 25 4K HEVC drone clips and 100 phone clips
- **THEN** all 125 appear in the media bin with thumbnails and durations, and no clip is copied or uploaded

### Requirement: Analyse once, reuse everywhere
Each clip SHALL get a contact sheet and, if it has speech, a transcript; one low-cost AI pass SHALL caption it, note motion and quality, and mark its best moments. Results SHALL be cached by content hash and reused by later projects without charging again.

#### Scenario: Same clip in a second project
- **WHEN** a clip analysed for one project is added to another
- **THEN** its analysis appears at once and no AI credits are used

### Requirement: Prepare only what the video uses
After the plan is approved, or when the owner adds a clip to the timeline by hand, the app SHALL cut the chosen segment with handles, crop it to the video's aspect at the chosen position, rotate if needed, convert it to an editable H.264 file in the project's media folder, and point the layer at it. Speed changes SHALL stay editable in the project.

#### Scenario: Landscape drone shot in a vertical reel
- **WHEN** the plan uses seconds 3.5–6.7 of a 4K landscape drone clip in a 1080×1920 reel
- **THEN** the project gets a vertical 1188×2112 H.264 segment cropped at the chosen horizontal position, and the shot plays in Studio without stutter

### Requirement: Music with beats
The app SHALL offer a library of licensed tracks with beat grids, and SHALL detect beats in a track the owner adds after the owner confirms the rights to use it.

#### Scenario: Owner's own track
- **WHEN** the owner adds an MP3 and confirms the rights
- **THEN** the app detects its tempo and beats, and cuts can snap to them
