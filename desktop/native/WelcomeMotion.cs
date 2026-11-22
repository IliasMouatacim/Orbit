using System.Runtime.InteropServices;

namespace Orbit;

internal static class WelcomeMotion
{
    // SPI_GETCLIENTAREAANIMATION is the Windows preference for animations inside windows.
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")]
    static extern bool ReadSetting(uint action, uint parameter, out int enabled, uint flags);

    public static bool Enabled => !SystemInformation.HighContrast &&
        ReadSetting(0x1042, 0, out int enabled, 0) && enabled != 0;
}
