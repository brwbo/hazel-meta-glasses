#if DEBUG
import MWDATMockDevice
import SwiftUI
import UIKit

struct MockLensSurface: UIViewRepresentable {
    let glasses: any MockGlasses

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        let surface = glasses.services.display.createPreviewView()
        surface.frame = container.bounds
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(surface)
        return container
    }

    func updateUIView(_ view: UIView, context: Context) {}
}
#endif
