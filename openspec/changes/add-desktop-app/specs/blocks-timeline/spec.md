## ADDED Requirements

### Requirement: Graphic blocks as presets
DT.ly SHALL provide parameterised presets for common promo and real-estate graphics: title plate, chip with kicker, area reveal with traced outline and counter, location badge, price, big name, end card with call to action and contacts, logo tile, text-mask intro, watermark and colour looks. They SHALL take brand colours and fonts as parameters and produce ordinary editable layers.

#### Scenario: End card from brand kit
- **WHEN** `block.endCard` is applied with a logo, two phone numbers, an address, a website and the brand's lime accent
- **THEN** the comp gets editable layers that animate in, matching the KK Park end card's structure in the brand's colours

### Requirement: Timeline builder
DT.ly SHALL provide `timeline.build`, which turns a shot list (source, trim, duration, speed, crop, overlay block), a music track with beats, transitions, voiceover cues and ducking settings into a complete main comp: one precomp per shot, cuts snapped to beats within 0.3 s with at least 1 s per shot, transitions, voiceover layers, and music volume lowered under each line.

#### Scenario: Rebuild KK Park
- **WHEN** `timeline.build` is given KK Park's 22 shots, overlays, techno track with beats and 8 voiceover cues
- **THEN** the result has the same shot order and cut times (within one frame) as `kkpark/project/project.json`, and contact sheets of the two match
