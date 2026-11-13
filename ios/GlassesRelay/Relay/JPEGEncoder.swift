import CoreGraphics
import Foundation
import ImageIO

enum JPEGEncoder {
    static let longSide = 640
    static let quality = 0.6
    static let maxBytes = 1_000_000

    static func encode(_ image: CGImage) -> Data? {
        let scaled = scale(image) ?? image
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, scaled, options)
        guard CGImageDestinationFinalize(destination) else { return nil }
        let bytes = data as Data
        guard bytes.count <= maxBytes, bytes.starts(with: [0xFF, 0xD8]) else { return nil }
        return bytes
    }

    private static func scale(_ image: CGImage) -> CGImage? {
        let longest = max(image.width, image.height)
        guard longest > longSide else { return nil }
        let factor = Double(longSide) / Double(longest)
        let width = max(2, Int((Double(image.width) * factor).rounded()))
        let height = max(2, Int((Double(image.height) * factor).rounded()))
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }
}
