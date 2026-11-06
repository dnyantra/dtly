## ADDED Requirements

### Requirement: Free watermarked preview, counted final export
The owner SHALL be able to export a watermarked 720p preview at any time without using allowance or credits. A final export SHALL require a grant from CustomerPro, which applies the plan's monthly videos and per-video credit price (CustomerPro D12, re-export within 7 days and the WhatsApp copy free).

#### Scenario: Allowance used up
- **WHEN** the workspace has used its monthly videos and the owner exports a final video
- **THEN** the app shows the credit price and the balance, and renders only after the owner confirms

### Requirement: Render locally
Final export SHALL render on the owner's computer: 1080×1920 (or the project's size) H.264 at about 8 Mbps with AAC audio, and optionally a WhatsApp copy under 16 MB. It SHALL show progress and time left, and SHALL be cancellable.

#### Scenario: 60-second reel on the reference laptop
- **WHEN** the KK Park reel is exported on a Core i5, 16 GB laptop
- **THEN** it finishes in under 10 minutes and the file is under 70 MB

### Requirement: Publish to the Media Library
Publishing SHALL upload the export to the project's renders folder and record it in the CustomerPro Media Library, ready for posts and WhatsApp. Interrupted uploads SHALL resume.

#### Scenario: Connection drops at 60%
- **WHEN** the upload is interrupted and the connection returns
- **THEN** it resumes from the last completed part, and the video appears once in the Media Library
