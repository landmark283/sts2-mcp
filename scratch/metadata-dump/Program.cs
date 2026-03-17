using System.Reflection;
using System.Runtime.InteropServices;

var gameDir = @"E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64";
var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();

var runtimePaths = Directory.GetFiles(runtimeDir, "*.dll");
var gamePaths = new[]
{
    Path.Combine(gameDir, "sts2.dll"),
    Path.Combine(gameDir, "0Harmony.dll"),
    Path.Combine(gameDir, "GodotSharp.dll"),
    Path.Combine(gameDir, "JetBrains.Annotations.dll"),
    Path.Combine(gameDir, "SmartFormat.dll"),
    Path.Combine(gameDir, "SmartFormat.ZString.dll")
}.Where(File.Exists);

var resolverPaths = runtimePaths
    .Concat(gamePaths)
    .Distinct(StringComparer.OrdinalIgnoreCase)
    .ToArray();

using var metadataContext = new MetadataLoadContext(
    new PathAssemblyResolver(resolverPaths),
    "System.Private.CoreLib");
var assemblyPath = Path.Combine(gameDir, "sts2.dll");
var assembly = metadataContext.LoadFromAssemblyPath(assemblyPath);

DumpMatchingTypes(assembly, "CardModel");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Models.CardModel");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Localization.DynamicVars.DynamicVar");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Localization.DynamicVars.DynamicVarSet");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Entities.Cards.CardPreviewMode");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Entities.Cards.PileType");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Models.CardModel+DescriptionPreviewType");
Console.WriteLine();
DumpMatchingTypes(assembly, "DescriptionPreviewType");
Console.WriteLine();
DumpType(assembly, "MegaCrit.Sts2.Core.Localization.LocString");

static void DumpType(Assembly assembly, string typeName)
{
    var type = assembly.GetType(typeName);
    if (type is null)
    {
        Console.WriteLine($"Type not found: {typeName}");
        return;
    }

    Console.WriteLine($"TYPE {type.FullName}");
    if (type.IsEnum)
    {
        Console.WriteLine("ENUM VALUES");
        foreach (var name in Enum.GetNames(type))
        {
            Console.WriteLine($"E {name}");
        }

        return;
    }

    Console.WriteLine("PROPERTIES");
    foreach (var property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                 .OrderBy(p => p.Name))
    {
        Console.WriteLine($"P {property.PropertyType.FullName} {property.Name}");
    }

    Console.WriteLine("METHODS");
    foreach (var method in type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                 .OrderBy(m => m.Name))
    {
        var parameters = string.Join(", ", method.GetParameters().Select(p => $"{p.ParameterType.FullName} {p.Name}"));
        Console.WriteLine($"M {method.ReturnType.FullName} {method.Name}({parameters})");
    }
}

static void DumpMatchingTypes(Assembly assembly, string suffix)
{
    Console.WriteLine($"TYPES matching *{suffix}");
    foreach (var type in assembly.GetTypes()
                 .Where(type => type.Name.Contains(suffix, StringComparison.OrdinalIgnoreCase))
                 .OrderBy(type => type.FullName))
    {
        Console.WriteLine(type.FullName);
    }
}
