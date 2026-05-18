---
title: "Institute for Quantum Computing"
year: 2025
date: 2025-08-01
tags: [work, quantum]
summary: "Simulating millimetre-wave resonators for superconducting quantum circuits at IQC."
---

At IQC, I used COMSOL Multiphysics software to simulate and design millimetre-wave (4–40 GHz) resonator circuits under the supervision of Dr. Brad Hauer. The goal of my project was to design resonators to be fabricated on a sapphire wafer and cooled to ~10 mK in a dilution fridge, where their quality factor can be measured.

The quality factor tells us two main things about the resonator:

**A) How long it will resonate.** How much of its energy is lost as it resonates. Imagine a bell which rings out for a very long time when struck, vs one which goes "clunk" and dies off quickly. The long-ringing (high quality) bell has a high Q-factor, while the cheap clunky bell has a low Q-factor.

**B) How narrow its frequency band is.** A bell with a high Q-factor will ring with a very specific frequency, whereas a cheap bell with a low Q-factor will emit a wide range of frequencies. A crystal wine glass vibrates and eventually shatters when enough resonant energy builds up — a sign of a very high Q.

High frequency selectivity is essential for quantum circuits. If resonators overlap in frequency, they interfere with each other, introducing noise and corrupting the tiny signals we're trying to measure. Resonators with high Q-factor can also store information and remain "coherent" for longer periods of time — think: bell ringing for a long time.

Most superconducting resonators are in the 4–8 GHz range, so our research on high-frequency 4–40 GHz resonators provides overlap with existing data while also probing underexplored territory. One of the key advantages of higher-frequency resonators is their much smaller footprint, which scales down with increasing frequency.

The resonators I designed were LC-circuits, with an inductor component and a capacitor component. The inductor stored energy in a magnetic field; the capacitor stored energy in an electric field. Resonance occurred as energy oscillated between them.

I worked with two resonator designs. The first is a lumped element design, with a meandering inductor at the top and an interdigitated capacitor at the bottom. The second is a spiral resonator, which blends both elements together into a more compact shape. My simulations helped predict resonant frequencies and coupling rates — helpful for an accurate measurement of the quality factor.

![COMSOL simulation output showing resonator designs on sapphire wafer](/images/IQCResonators.png)
