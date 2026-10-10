// Encodes numbered PNG frames into an H.264 MP4 with AVFoundation, which ships with macOS.
// Usage: swift encode.swift <frames-dir> <output.mp4> [fps]
import AVFoundation
import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
  FileHandle.standardError.write("Usage: swift encode.swift <frames-dir> <output.mp4> [fps]\n".data(using: .utf8)!)
  exit(2)
}
let framesDirectory = URL(fileURLWithPath: arguments[1])
let output = URL(fileURLWithPath: arguments[2])
let fps = Int32(arguments.count > 3 ? Int(arguments[3]) ?? 30 : 30)

let frames = try FileManager.default.contentsOfDirectory(atPath: framesDirectory.path)
  .filter { $0.hasSuffix(".png") }
  .sorted()
guard let first = NSImage(contentsOf: framesDirectory.appendingPathComponent(frames[0])),
  let firstImage = first.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fatalError("Could not read the first frame") }
let width = firstImage.width
let height = firstImage.height

try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: 8_000_000,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
  ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
  assetWriterInput: input,
  sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

for (index, name) in frames.enumerated() {
  autoreleasepool {
    guard let image = NSImage(contentsOf: framesDirectory.appendingPathComponent(name)),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let pool = adaptor.pixelBufferPool
    else { fatalError("Could not read \(name)") }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    guard let pixelBuffer = buffer else { fatalError("No pixel buffer") }
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    let context = CGContext(
      data: CVPixelBufferGetBaseAddress(pixelBuffer), width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)
    context?.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
    adaptor.append(pixelBuffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps))
  }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fatalError("Encoding failed: \(String(describing: writer.error))") }
print("Wrote \(frames.count) frames to \(output.path)")
