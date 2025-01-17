import { gl, WEBGL_draw_buffers, canvas } from '../init';
import { mat4 } from 'gl-matrix';
import { loadShaderProgram, renderFullscreenQuad } from '../utils';
import { NUM_LIGHTS, FRUSTUM_NEAR_DEPTH, FRUSTUM_FAR_DEPTH } from '../scene';
import toTextureVert from '../shaders/deferredToTexture.vert.glsl';
import toTextureFrag from '../shaders/deferredToTexture.frag.glsl';
import toTextureFragNoPosition from '../shaders/deferredToTextureNoPosition.frag.glsl';
import QuadVertSource from '../shaders/quad.vert.glsl';
import deferredFsSource from '../shaders/deferred.frag.glsl.js';
import deferredFsNoPositionSource from '../shaders/deferredNoPosition.frag.glsl.js';
import bloomFsSource from '../shaders/deferredBloom.frag.glsl.js';
import bloomGaussianSource from '../shaders/deferredBloomGaussian.frag.glsl';
import bloomFinalSource from '../shaders/deferredBloomFinal.frag.glsl';
import TextureBuffer from './textureBuffer';
import BaseRenderer, {MAX_LIGHTS_PER_CLUSTER} from './base';

export const GAUSSIAN_KERNEL_11 = new Float32Array([
  0.006849,	0.007239,	0.007559,	0.007795,	0.007941,	0.00799 ,       0.007941,	0.007795,	0.007559,	0.007239,	0.006849,
  0.007239,	0.007653,	0.00799 ,        0.00824,       0.008394,	0.008446,	0.008394,	0.00824 ,        0.00799,       0.007653,	0.007239,
  0.007559,	0.00799	,       0.008342,	0.008604,	0.008764,	0.008819,	0.008764,	0.008604,	0.008342,	0.00799 ,        0.007559,
  0.007795,	0.00824	,       0.008604,	0.008873,	0.009039,	0.009095,	0.009039,	0.008873,	0.008604,	0.00824 ,        0.007795,
  0.007941,	0.008394,	0.008764,	0.009039,	0.009208,	0.009265,	0.009208,	0.009039,	0.008764,	0.008394,	0.007941,
  0.00799 ,   0.008446,	0.008819,	0.009095,	0.009265,	0.009322,	0.009265,	0.009095,	0.008819,	0.008446,	0.00799 ,
  0.007941,	0.008394,	0.008764,	0.009039,	0.009208,	0.009265,	0.009208,	0.009039,	0.008764,	0.008394,	0.007941,
  0.007795,	0.00824	,       0.008604,	0.008873,	0.009039,	0.009095,	0.009039,	0.008873,	0.008604,	0.00824 ,        0.007795,
  0.007559,	0.00799	,       0.008342,	0.008604,	0.008764,	0.008819,	0.008764,	0.008604,	0.008342,	0.00799 ,        0.007559,
  0.007239,	0.007653,	0.00799 ,        0.00824,       0.008394,	0.008446,	0.008394,	0.00824 ,        0.00799,       0.007653,	0.007239,
  0.006849,	0.007239,	0.007559,	0.007795,	0.007941,	0.00799 ,       0.007941,	0.007795,	0.007559,	0.007239,	0.006849
]);

export const SHOW_BLOOM = true;
// Only set one of these perf optimizations to true if show_bloom is false
export const G_BUFFER_NO_POSITION = false;

export const NUM_GBUFFERS = G_BUFFER_NO_POSITION ? 2 : 3;

export default class ClusteredDeferredRenderer extends BaseRenderer {
  constructor(xSlices, ySlices, zSlices) {
    super(xSlices, ySlices, zSlices);
    
    this.setupDrawBuffers(canvas.width, canvas.height);
    
    // Create a texture to store light data
    this._lightTexture = new TextureBuffer(NUM_LIGHTS, 8);

    const progCopyFragSource = G_BUFFER_NO_POSITION ? toTextureFragNoPosition : toTextureFrag;
    
    this._progCopy = loadShaderProgram(toTextureVert, progCopyFragSource, {
      uniforms: ['u_viewProjectionMatrix', 'u_colmap', 'u_normap', 'u_viewMat'],
      attribs: ['a_position', 'a_normal', 'a_uv'],
    });

    const fsSource = SHOW_BLOOM ? bloomFsSource
      : G_BUFFER_NO_POSITION ? deferredFsNoPositionSource : deferredFsSource;

    this._progShade = loadShaderProgram(QuadVertSource, fsSource({
      numLights: NUM_LIGHTS,
      numGBuffers: NUM_GBUFFERS,
      maxLightsPerCluster: MAX_LIGHTS_PER_CLUSTER,
      xSlices: xSlices,
      ySlices: ySlices,
      zSlices: zSlices,
      frustumNearDepth: FRUSTUM_NEAR_DEPTH,
      frustumFarDepth: FRUSTUM_FAR_DEPTH,
      textureWidth: this._clusterTexture._elementCount,
      textureHeight: this._clusterTexture._pixelsPerElement,
    }), {
      uniforms: ['u_gbuffers[0]', 'u_gbuffers[1]', 'u_gbuffers[2]', 'u_gbuffers[3]',
        'u_screenSize', 'u_viewMat', 'u_clusterbuffer', 'u_lightbuffer', 'u_fov', 'u_viewInv'],
      attribs: ['a_position', 'a_uv'],
    });

    this._progBloomGaussian = loadShaderProgram(QuadVertSource, bloomGaussianSource, {
      uniforms: ['u_brightBuffer', 'u_screenSize', 'u_gaussianKernel'],
      attribs: ['a_position', 'a_uv'],
    });

    this._progBloomFinal = loadShaderProgram(QuadVertSource, bloomFinalSource, {
      uniforms: ['u_blurBuffer', 'u_renderBuffer'],
      attribs: ['a_position', 'a_uv'],
    });

    this._projectionMatrix = mat4.create();
    this._viewMatrix = mat4.create();
    this._viewProjectionMatrix = mat4.create();
  }

  setupMultipleRenderTargets(buffers, num) {
    let attachments = new Array(NUM_GBUFFERS);

    for (let i = 0; i < num; i++) {
      attachments[i] = WEBGL_draw_buffers[`COLOR_ATTACHMENT${i}_WEBGL`];
      buffers[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, buffers[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.FLOAT, null);
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.framebufferTexture2D(gl.FRAMEBUFFER, attachments[i], gl.TEXTURE_2D, buffers[i], 0);      
    }

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE) {
      throw "Framebuffer incomplete";
    }

    // Tell the WEBGL_draw_buffers extension which FBO attachments are
    // being used. (This extension allows for multiple render targets.)
    WEBGL_draw_buffers.drawBuffersWEBGL(attachments);
  }

  setupDrawBuffers(width, height) {
    this._width = width;
    this._height = height;

    this._fbo = gl.createFramebuffer();
    
    //Create, bind, and store a depth target texture for the FBO
    this._depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._depthTex, 0);

    // Create, bind, and store "color" target textures for the FBO
    this._gbuffers = new Array(NUM_GBUFFERS);
    this.setupMultipleRenderTargets(this._gbuffers, NUM_GBUFFERS);

    if (SHOW_BLOOM) {
      // Create a frame buffer for 2 outputs: 1) rendered image and 2) image to blur
      this._bloomFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomFbo);

      this._bloomBuffers = new Array(2);
      this.setupMultipleRenderTargets(this._bloomBuffers, 2);

      // Create another frame buffer for just 1 output: gaussian blurred image
      this._bloomBlurFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomBlurFbo);

      this._bloomBlurBuffer = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._bloomBlurBuffer);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.FLOAT, null);
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._bloomBlurBuffer, 0);    

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE) {
        throw "Bloom 2st framebuffer incomplete";
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width, height) {
    this._width = width;
    this._height = height;

    gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
    for (let i = 0; i < NUM_GBUFFERS; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this._gbuffers[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    }

    if (SHOW_BLOOM) {
      // resize the post process texture buffers as well
      gl.bindTexture(gl.TEXTURE_2D, this._bloomBuffers[0]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);

      gl.bindTexture(gl.TEXTURE_2D, this._bloomBuffers[1]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);

      gl.bindTexture(gl.TEXTURE_2D, this._bloomBlurBuffer);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(camera, scene) {
    if (canvas.width != this._width || canvas.height != this._height) {
      this.resize(canvas.width, canvas.height);
    }

    // Update the camera matrices
    camera.updateMatrixWorld();
    mat4.invert(this._viewMatrix, camera.matrixWorld.elements);
    mat4.copy(this._projectionMatrix, camera.projectionMatrix.elements);
    mat4.multiply(this._viewProjectionMatrix, this._projectionMatrix, this._viewMatrix);

    // Render to the whole screen
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Bind the framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);

    // Clear the frame
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Use the shader program to copy to the draw buffers
    gl.useProgram(this._progCopy.glShaderProgram);

    // Upload the camera matrix
    gl.uniformMatrix4fv(this._progCopy.u_viewProjectionMatrix, false, this._viewProjectionMatrix);
    gl.uniformMatrix4fv(this._progCopy.u_viewMat, false, this._viewMatrix);

    // Draw the scene. This function takes the shader program so that the model's textures can be bound to the right inputs
    scene.draw(this._progCopy);
    
    // Update the buffer used to populate the texture packed with light data
    for (let i = 0; i < NUM_LIGHTS; ++i) {
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 0] = scene.lights[i].position[0];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 1] = scene.lights[i].position[1];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 2] = scene.lights[i].position[2];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 3] = scene.lights[i].radius;

      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 1) + 0] = scene.lights[i].color[0];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 1) + 1] = scene.lights[i].color[1];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 1) + 2] = scene.lights[i].color[2];
    }
    // Update the light texture
    this._lightTexture.update();

    // Update the clusters for the frame
    this.updateClusters(camera, this._viewMatrix, scene);

    if (SHOW_BLOOM) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomFbo);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      // Bind the default null framebuffer which is the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // Clear the frame
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    // Use this shader program
    gl.useProgram(this._progShade.glShaderProgram);

    // TODO: Bind any other shader inputs
    gl.uniform2f(this._progShade.u_screenSize, gl.canvas.width, gl.canvas.height);
    gl.uniformMatrix4fv(this._progShade.u_viewInv, false, camera.matrixWorld.elements);
    gl.uniform1f(this._progShade.u_fov, camera.fov * Math.PI / 180);

    // console.log(camera.matrixWorld.elements);
  
    // Bind g-buffers
    const firstGBufferBinding = 0; // You may have to change this if you use other texture slots
    for (let i = 0; i < NUM_GBUFFERS; i++) {
      gl.activeTexture(gl[`TEXTURE${i + firstGBufferBinding}`]);
      gl.bindTexture(gl.TEXTURE_2D, this._gbuffers[i]);
      gl.uniform1i(this._progShade[`u_gbuffers[${i}]`], i + firstGBufferBinding);
    }

    // Set the light texture as a uniform input to the shader
    gl.activeTexture(gl[`TEXTURE${NUM_GBUFFERS}`]);
    gl.bindTexture(gl.TEXTURE_2D, this._lightTexture.glTexture);
    gl.uniform1i(this._progShade.u_lightbuffer, NUM_GBUFFERS);

    // Set the cluster texture as a uniform input to the shader
    gl.activeTexture(gl[`TEXTURE${NUM_GBUFFERS + 1}`]);
    gl.bindTexture(gl.TEXTURE_2D, this._clusterTexture.glTexture);
    gl.uniform1i(this._progShade.u_clusterbuffer, NUM_GBUFFERS + 1);

    if (SHOW_BLOOM) {
      renderFullscreenQuad(this._progShade);

      // Gaussian blur for bloom
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomBlurFbo);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(this._progBloomGaussian.glShaderProgram);

      gl.activeTexture(gl[`TEXTURE0`]);
      gl.bindTexture(gl.TEXTURE_2D, this._bloomBuffers[1]);
      gl.uniform1i(this._progBloomGaussian.u_brightBuffer, 0);

      gl.uniform2f(this._progBloomGaussian.u_screenSize, gl.canvas.width, gl.canvas.height);
      gl.uniform1fv(this._progBloomGaussian.u_gaussianKernel, GAUSSIAN_KERNEL_11);

      renderFullscreenQuad(this._progBloomGaussian);

      // Bind the default null framebuffer which is the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clear(gl.COLOR_BUFFER_BIT| gl.DEPTH_BUFFER_BIT);

      // Combine gaussian blur + rendered image
      gl.useProgram(this._progBloomFinal.glShaderProgram);

      gl.activeTexture(gl[`TEXTURE0`]);
      gl.bindTexture(gl.TEXTURE_2D, this._bloomBuffers[0]);
      gl.uniform1i(this._progBloomFinal.u_renderBuffer, 0);

      gl.activeTexture(gl[`TEXTURE1`]);
      gl.bindTexture(gl.TEXTURE_2D, this._bloomBlurBuffer);
      gl.uniform1i(this._progBloomFinal.u_blurBuffer, 1);

      renderFullscreenQuad(this._progBloomFinal);

    } else {
      renderFullscreenQuad(this._progShade);
    }
  }
};
