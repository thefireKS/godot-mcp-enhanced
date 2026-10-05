// A-02: TODO(v0.20.0) — Remove this file once all deprecated properties have been
// fully removed from Godot and no longer need mapping. Until then, this file provides
// backward-compatible property name translation for the docs tool and lint rules.
// IMPORTANT-15 (review): 部分条目 removed:true(Environment.physically_based_lights_enabled、
// RigidBody3D.bounce/friction、CylinderMesh.radius,已在 Godot 4 移除,保留用于 docs 提示与
// lint 映射);其余 removed:false(仍需向后兼容翻译)。待全部条目从 Godot 移除且无引用后清理。

export interface DeprecatedProperty {
  removed: boolean;
  replacement?: string;
  /** Lint rule ID that handles this property */
  lintRule?: string;
}

export const DEPRECATED_PROPERTIES: Record<string, Record<string, DeprecatedProperty>> = {
  "Environment": {
    "adjustments_enabled": { removed: false, replacement: "adjustment_enabled", lintRule: "L004" },
    "adjustments_brightness": { removed: false, replacement: "adjustment_brightness", lintRule: "L004" },
    "adjustments_contrast": { removed: false, replacement: "adjustment_contrast", lintRule: "L004" },
    "adjustments_saturation": { removed: false, replacement: "adjustment_saturation", lintRule: "L004" },
    "tone_mapper": { removed: false, replacement: "tonemap_mode", lintRule: "L005" },
    "physically_based_lights_enabled": { removed: true, lintRule: "L011" },
  },
  "Node3D": {
    "visibility_range_begin": { removed: false, replacement: "GeometryInstance3D.visibility_range_begin", lintRule: "L007" },
    "visibility_range_end": { removed: false, replacement: "GeometryInstance3D.visibility_range_end", lintRule: "L007" },
  },
  "SoftBody3D": {
    "mass": { removed: false, replacement: "total_mass", lintRule: "L006" },
    "linear_damping": { removed: false, replacement: "damping_coefficient" },
  },
  "RigidBody3D": {
    "bounce": { removed: true, replacement: "PhysicsMaterial.bounce via physics_material_override", lintRule: "L002" },
    "friction": { removed: true, replacement: "PhysicsMaterial.friction via physics_material_override" },
  },
  "CylinderMesh": {
    "radius": { removed: true, replacement: "set top_radius and bottom_radius separately", lintRule: "L003" },
  },
  "FogMaterial": {
    "albedo_color": { removed: false, replacement: "albedo", lintRule: "L010" },
  },
};
