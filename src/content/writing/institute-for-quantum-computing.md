---
title: "Institute for Quantum Computing"
year: 2025
date: 2025-08-01
tags: [work, quantum]
summary: "Simulating millimetre-wave resonators for superconducting quantum circuits at IQC."
---

At IQC, I used COMSOL Multiphysics software to simulate and design millimetre-wave (4-40 GHz) resonator circuits under the supervision of Dr. Brad Hauer. The goal of my project was to design resonators to be fabricated on a sapphire wafer and cooled to ~10 mK in a dilution fridge, where their quality factor can be measured.

The quality factor tells us two main things about the resonator:

**A)** How long it will resonate for (how much of its energy is lost as it resonates). Imagine a bell which rings out for a very long time when struck, vs one which goes "clunk" and dies off quickly. The long-ringing (high quality) bell has a high Q-factor, while the cheap clunky bell has a low Q-factor.

**B)** The second thing the Q-factor tells us is how narrow the frequency band is that it resonates at. A bell with a high Q-factor will ring with a very specific frequency, whereas a cheap bell with a low Q-factor will emit a wide range of frequencies ("clunk"). A crystal wine glass vibrates and eventually shatters when enough resonant energy builds up — a sign of a very high Q.

High frequency selectivity (i.e. high Q-factor) is essential for quantum circuits. If resonators overlap in frequency, they interfere with each other, introducing noise and corrupting the tiny signals we're trying to measure. Resonators with high Q-factor can also store information and remain "coherent" for longer periods of time (think: bell ringing for a long time).

Most superconducting resonators are in the 4-8 GHz range, so our research on high frequency 4-40 GHz resonators provides overlap — to compare our data to existing data — while also probing underexplored territory. One of the key advantages of higher-frequency resonators is their much smaller footprint, which scales down with increasing frequency.

The resonators I designed were LC-circuits, meaning they had an inductor component and a capacitor component. The inductor component stored energy in a magnetic field, while the capacitor component stored energy in an electric field. The resonance occurred as energy oscillated between these two components.

![COMSOL simulation output showing resonator designs on sapphire wafer](/images/IQCResonators.png)

I worked with two resonator designs. The first is a lumped element design, where there is a meandering inductor at the top and an interdigitated capacitor at the bottom, and the second is a spiral resonator, which blends both elements together into a more compact shape.

My simulations helped predict resonant frequencies and how to achieve various coupling rates, which is helpful for an accurate measurement of the quality factor.
