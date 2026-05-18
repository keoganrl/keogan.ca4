---
title: "D-Wave"
year: 2025
date: 2025-04-12
tags: [work, quantum]
summary: "Notes on quantum annealing and my time at D-Wave."
---

D-Wave builds quantum annealers — a type of quantum computer optimized for solving combinatorial optimization problems. Unlike gate-based quantum computers (IBM, Google), annealers don't run arbitrary quantum circuits. Instead, they find low-energy states of a physical system that correspond to solutions of a given problem.

The hardware is a superconducting chip kept at ~15 millikelvin, colder than outer space. Qubits are flux qubits — tiny loops of superconducting wire where current flows clockwise or counterclockwise (or both, in superposition).

What I found most interesting was the hybrid solver workflow: for problems too large to fit on the QPU directly, you decompose the problem, send subproblems to the quantum hardware, and stitch results back together classically. The QPU is used as a subroutine, not a standalone solver.
