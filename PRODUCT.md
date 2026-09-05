## Design Context

### Users

Primary users are software developers working with multiple AI coding agents. The main focus is solo power users in fast-moving tech startup environments, while still supporting small teams. Users juggle branches, terminals, diffs, previews, and task state at high speed. The product's job is to coordinate parallel coding workflows without losing clarity, control, or momentum.

### Brand Personality

Lightning fast, powerful, fluid.

The product should feel like Copilot under control: highly capable, responsive, and delightful, without feeling chaotic or opaque. The tone should stay pragmatic and confident rather than playful or ornamental. Users should feel focused, in command, and slightly impressed by how easily the interface keeps up.

### Aesthetic Direction

The product should remain dark-mode-first. The visual language should feel like a modern developer cockpit: technical, crisp, high-agency, and immediate. Use tools like iTerm2 as the benchmark for fluidity and responsiveness, while aiming for tighter, more intentional interactions.

Reference qualities to borrow:

- Instant visual response and low-latency feel
- Dense but readable information layouts
- Strong sense of control without clutter
- Polished motion and transitions that reinforce speed
- Terminal-native credibility with refined product craft

Anti-direction:

- Anything sluggish, heavy, or overcomplicated
- Bloated enterprise dashboards
- Decorative consumer-app styling
- Visual noise that obscures hierarchy or slows scanning
- Clever interactions that reduce predictability

### Shipped Workflow Commitments

- Task notes are readable from desktop and authenticated remote task details. The conflict-safe
  desktop debounce and explicit remote Save implementation is complete, but production writes stay
  unavailable until the exact clean committed artifact for each surface receives its own verified
  promotion entitlement. Once promoted, concurrent changes preserve the complete local draft and
  expose review/use-latest/overwrite recovery instead of silently choosing a winner.
- Switching a remote task between Terminal and Notes keeps the existing terminal session mounted,
  and reconnect reloads canonical notes without placing note content in bootstrap or live events.

### Design Principles

1. Optimize for felt speed, not just technical speed. Interactions should feel immediate, especially task switching, terminal use, file selection, diff viewing, and panel changes.
2. Keep power under control. The interface can be dense and highly capable, but state, ownership, and next actions must remain legible at a glance.
3. Make technical surfaces feel intentional. Panels, terminals, diffs, and status areas should look precise and engineered, not generic.
4. Use delight sparingly and purposefully. Motion, glow, and polish should reinforce responsiveness and confidence, never distract from work.
5. Prefer fluid workflows over visual ornament. If a design choice adds friction, ambiguity, or latency, it is the wrong choice.
