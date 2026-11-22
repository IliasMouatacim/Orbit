using System.Runtime.InteropServices;

namespace Orbit;

static class MotionProbe
{
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")]
    static extern bool SetSetting(uint action,uint parameter,nint value,uint flags);
    static IEnumerable<Control> Descendants(Control parent) =>
        parent.Controls.Cast<Control>().SelectMany(c => new[]{c}.Concat(Descendants(c)));

    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        bool original=WelcomeMotion.Enabled;
        using var window = new MainWindow();
        window.Shown += async (_,_) => {
            try {
                foreach(bool motion in new[]{true,false}) {
                    if(!SetSetting(0x1043,0,motion?1:0,2) || WelcomeMotion.Enabled!=motion) throw new Exception("Motion setting");
                    window.Activate();
                    await Task.Delay(700);
                    var art=Descendants(window).OfType<WelcomeArtwork>().Single();
                    using var a=new Bitmap(art.Width,art.Height);using var b=new Bitmap(art.Width,art.Height);
                    art.DrawToBitmap(a,art.ClientRectangle);
                    await Task.Delay(900);
                    art.DrawToBitmap(b,art.ClientRectangle);
                    int changed=0;
                    for(int y=10;y<a.Height-10;y+=5) for(int x=10;x<a.Width-10;x+=5) if(a.GetPixel(x,y)!=b.GetPixel(x,y)) changed++;
                    if(motion ? changed<20 : changed!=0) throw new Exception($"Motion={motion}: {changed} changed samples");
                    var tabs=Descendants(window).OfType<RadioButton>().ToArray();
                    tabs[0].Focus();
                    SendKeys.SendWait("{RIGHT}");await Task.Delay(260);
                    if(!tabs[1].Checked) throw new Exception("Keyboard sign in");
                    SendKeys.SendWait("{RIGHT}");await Task.Delay(260);
                    if(!tabs[2].Checked || !Descendants(window).Any(c=>c.Text=="Email (optional)" && c.Visible)) throw new Exception("Keyboard registration");
                    tabs[0].Checked=true;await Task.Delay(260);
                }
            } catch(Exception e){File.WriteAllText("motion-error.txt",e.ToString()); Environment.ExitCode=1;}
            finally {SetSetting(0x1043,0,original?1:0,2);window.Close();}
        };
        Application.Run(window);
    }
}
