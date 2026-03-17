using System.Reflection;
using System.Runtime.Loader;

var asmPath = @"E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64\sts2.dll";
var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var gameDir = Path.GetDirectoryName(asmPath)!;
var runtimeAssemblies = Directory.GetFiles(runtimeDir, "*.dll").ToArray();
var runtimeAssemblyNames = runtimeAssemblies.Select(static path => Path.GetFileName(path)).ToHashSet(StringComparer.OrdinalIgnoreCase);
var gameAssemblies = Directory.GetFiles(gameDir, "*.dll").Where(path => !runtimeAssemblyNames.Contains(Path.GetFileName(path)));
var resolverPaths = runtimeAssemblies.Concat(gameAssemblies).Append(asmPath).Distinct(StringComparer.OrdinalIgnoreCase);
var resolver = new PathAssemblyResolver(resolverPaths);
using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
var asm = mlc.LoadFromAssemblyPath(asmPath);
foreach (var target in new[]{"MegaCrit.Sts2.Core.Models.RelicModel","MegaCrit.Sts2.Core.Models.PowerModel","MegaCrit.Sts2.Core.Models.PotionModel","MegaCrit.Sts2.Core.Models.AbstractModel"}) {
  var type = asm.GetType(target, false, false);
  Console.WriteLine($"=== {target} ===");
  if (type is null) { Console.WriteLine("<missing>\n"); continue; }
  foreach (var method in type.GetMethods(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.DeclaredOnly).OrderBy(m => m.Name, StringComparer.Ordinal)) {
    if (method.Name.Contains("Desc", StringComparison.OrdinalIgnoreCase) || method.Name.Contains("Text", StringComparison.OrdinalIgnoreCase) || method.Name.Contains("Format", StringComparison.OrdinalIgnoreCase) || method.Name.Contains("Tooltip", StringComparison.OrdinalIgnoreCase) || method.Name.Contains("Hover", StringComparison.OrdinalIgnoreCase)) {
      var ps = string.Join(", ", method.GetParameters().Select(p => $"{p.ParameterType.Name} {p.Name}"));
      Console.WriteLine($"METHOD {method.ReturnType.Name} {method.Name}({ps})");
    }
  }
  foreach (var prop in type.GetProperties(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.DeclaredOnly).OrderBy(p => p.Name, StringComparer.Ordinal)) {
    if (prop.Name.Contains("Desc", StringComparison.OrdinalIgnoreCase) || prop.Name.Contains("Text", StringComparison.OrdinalIgnoreCase) || prop.Name.Contains("Tooltip", StringComparison.OrdinalIgnoreCase) || prop.Name.Contains("Hover", StringComparison.OrdinalIgnoreCase)) {
      Console.WriteLine($"PROPERTY {prop.PropertyType.Name} {prop.Name}");
    }
  }
  Console.WriteLine();
}
