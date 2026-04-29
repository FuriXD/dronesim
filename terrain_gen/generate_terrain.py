import argparse
import os
import cv2
import numpy as np
import trimesh
from PIL import Image
import torch
from transformers import pipeline

def load_depth_model():
    print("Loading AI Depth Estimation model...")
    # LiheYoung/depth-anything-small-hf is highly robust for varied environments
    pipe = pipeline(task="depth-estimation", model="LiheYoung/depth-anything-small-hf")
    return pipe

def process_depth_map(depth_img):
    """
    Normalizes the AI depth output, applies smoothing and edge enhancements.
    """
    print("Processing heightmap...")
    # Convert PIL Image to numpy array
    depth_np = np.array(depth_img)
    
    # Normalize to 0-1
    depth_min = depth_np.min()
    depth_max = depth_np.max()
    normalized = (depth_np - depth_min) / (depth_max - depth_min)
    
    # Scale to 0-255 for cv2 processing
    gray = (normalized * 255).astype(np.uint8)
    
    # Apply Bilateral Filter (preserves sharp edges like cliffs, smooths flat areas)
    filtered = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)
    
    # Further smooth with a light Gaussian blur to remove micro noise
    smoothed = cv2.GaussianBlur(filtered, (5, 5), 0)
    
    # Normalize back to 0-1 float for mesh displacement
    final_heightmap = smoothed.astype(np.float32) / 255.0
    
    return final_heightmap, smoothed

def generate_terrain_mesh(heightmap, texture_path, output_mesh_path, height_scale=0.2):
    """
    Generates a 3D mesh from a normalized heightmap and applies the texture.
    """
    print(f"Generating 3D mesh (Scale Z: {height_scale})...")
    h, w = heightmap.shape
    
    # We may want to downsample the grid if the image is extremely large 
    # to avoid creating a mesh with millions of polygons.
    # Let's target a max width of 1024 for the geometry grid.
    max_grid_size = 1024
    if w > max_grid_size or h > max_grid_size:
        scale_factor = max_grid_size / max(w, h)
        new_w = int(w * scale_factor)
        new_h = int(h * scale_factor)
        print(f"Downsampling geometry grid to {new_w}x{new_h} for mesh optimization...")
        # Note: we only downsample the geometry, the texture remains full resolution.
        heightmap = cv2.resize(heightmap, (new_w, new_h), interpolation=cv2.INTER_AREA)
        h, w = new_h, new_w

    # Create coordinate grid
    x = np.linspace(-1, 1, w)
    z = np.linspace(-1, 1, h)
    xx, zz = np.meshgrid(x, z)
    
    # Vertices array: (X, Y, Z)
    vertices = np.zeros((h * w, 3), dtype=np.float32)
    vertices[:, 0] = xx.flatten()
    vertices[:, 1] = heightmap.flatten() * height_scale  # Y is up
    vertices[:, 2] = zz.flatten()
    
    # UV mapping
    uvs = np.zeros((h * w, 2), dtype=np.float32)
    # u goes 0 to 1 across width
    u_row = np.linspace(0, 1, w)
    # v goes 1 to 0 across height (image coordinates to UV coordinates)
    v_col = np.linspace(1, 0, h)
    
    uvs[:, 0] = np.tile(u_row, h)
    uvs[:, 1] = np.repeat(v_col, w)
    
    # Generate faces (2 triangles per grid cell)
    faces = []
    # Vectorized face generation for speed
    i = np.arange(h - 1)
    j = np.arange(w - 1)
    ii, jj = np.meshgrid(i, j, indexing='ij')
    
    tl = (ii * w + jj).flatten()
    tr = tl + 1
    bl = ((ii + 1) * w + jj).flatten()
    br = bl + 1
    
    # Triangles: Top-Left -> Bottom-Left -> Top-Right
    #            Top-Right -> Bottom-Left -> Bottom-Right
    faces1 = np.column_stack((tl, bl, tr))
    faces2 = np.column_stack((tr, bl, br))
    faces = np.vstack((faces1, faces2))
    
    print("Applying texture mapping...")
    # Load texture
    texture_image = Image.open(texture_path).convert('RGB')
    material = trimesh.visual.material.SimpleMaterial(image=texture_image)
    visuals = trimesh.visual.TextureVisuals(uv=uvs, material=material)
    
    # Create Trimesh object
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, visual=visuals, process=False)
    
    print(f"Exporting mesh to {output_mesh_path}...")
    # GLB format packs the texture and mesh into a single binary file (ideal for Unity/Unreal)
    mesh.export(output_mesh_path)
    print("Export complete!")

def main():
    parser = argparse.ArgumentParser(description="Convert 2D Satellite/Aerial Image to 3D Terrain Model")
    parser.add_argument("--input", "-i", type=str, required=True, help="Path to input high-res image")
    parser.add_argument("--output_dir", "-o", type=str, default="output", help="Directory to save the output files")
    parser.add_argument("--scale", "-s", type=float, default=0.25, help="Elevation scale multiplier")
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"Error: Input file {args.input} not found.")
        return
        
    os.makedirs(args.output_dir, exist_ok=True)
    
    base_name = os.path.splitext(os.path.basename(args.input))[0]
    out_heightmap_path = os.path.join(args.output_dir, f"{base_name}_heightmap.png")
    out_mesh_path = os.path.join(args.output_dir, f"{base_name}_terrain.glb")
    
    # 1. Load Image
    print(f"Loading image: {args.input}")
    image = Image.open(args.input).convert("RGB")
    
    # 2. AI Depth Estimation
    pipe = load_depth_model()
    print("Running depth estimation...")
    depth_output = pipe(image)["depth"]
    
    # 3. Process Heightmap
    heightmap, heightmap_vis = process_depth_map(depth_output)
    
    # Save heightmap
    cv2.imwrite(out_heightmap_path, heightmap_vis)
    print(f"Saved heightmap to {out_heightmap_path}")
    
    # 4. Generate & Export 3D Mesh
    generate_terrain_mesh(heightmap, args.input, out_mesh_path, height_scale=args.scale)
    
    print("\n✅ Process finished successfully!")
    print(f"Heightmap: {out_heightmap_path}")
    print(f"3D Model:  {out_mesh_path}")

if __name__ == "__main__":
    main()
