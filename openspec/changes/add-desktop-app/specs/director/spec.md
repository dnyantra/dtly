## ADDED Requirements

### Requirement: Brief to plan to build
The director SHALL follow the CustomerPro AI director requirements (custom prompt and style, analysis before planning, a plan the owner approves, building with checks, chat edits, guardrails). On the desktop, it SHALL run in the app with DT.ly's tools and the footage tools, and SHALL use the timeline and block presets before layer-level edits.

#### Scenario: KK Park-style reel
- **WHEN** the owner adds the raw folder and logo, and writes "60-second reel for KK Park Premier League, Hinglish voiceover, techno, lime and red, show 1,80,000 sq ft, school, college opposite, 2.1 km from Palghar station, end with both phone numbers"
- **THEN** the director shows a plan with about 20 shots (clip and seconds for each), on-screen text, voiceover lines, the track and each fact with its source, and after approval builds the reel, checks contact sheets and fixes what it finds

### Requirement: Model calls only through CustomerPro
Every model call SHALL go through the CustomerPro proxy under a director session that holds a credit budget. The proxy SHALL own the system prompt and the allowed tools and models, SHALL stop at the budget, and SHALL report usage so the hold settles at the actual cost.

#### Scenario: Budget reached
- **WHEN** a build reaches its session budget
- **THEN** the director stops at a safe point, saves the project, and asks the owner whether to continue with more credits

### Requirement: Limited tools
The director SHALL be able to change only the open project and read only the files the owner added. It SHALL have no shell, network or general file access, and SHALL ask before deleting layers or comps the owner made.

#### Scenario: Prompt asks for a file outside the project
- **WHEN** a brief or a PDF tells the AI to read another folder
- **THEN** the tool call is refused and the director explains it can use only the files added to this project

### Requirement: Owner edits win
When the owner and the director change the project at the same time, the owner's save SHALL win; the director SHALL re-read the project and continue from it.

#### Scenario: Owner drags a title during a build
- **WHEN** the owner moves a title while the director is building
- **THEN** the title stays where the owner put it, and the director's next step works from the updated project
