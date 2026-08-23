// The fake-terminal paint assertions need Ink's interactive renderer, and Ink
// silently disables frame rendering whenever CI is set — every UI test then
// asserts against an empty frame. Arc's own gates export CI=1 (as CI systems
// do), which is exactly how the self-arc's test gate found this.
delete process.env.CI
