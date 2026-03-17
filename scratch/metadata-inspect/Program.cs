using System.Reflection;
using System.Runtime.Loader;

var asmPath = @"E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64\sts2.dll";
var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var gameDir = Path.GetDirectoryName(asmPath)!;
var runtimeAssemblies = Directory.GetFiles(runtimeDir, "*.dll").ToArray();
var runtimeAssemblyNames = runtimeAssemblies
    .Select(static path => Path.GetFileName(path))
    .ToHashSet(StringComparer.OrdinalIgnoreCase);
var gameAssemblies = Directory
    .GetFiles(gameDir, "*.dll")
    .Where(path => !runtimeAssemblyNames.Contains(Path.GetFileName(path)));
var resolverPaths = runtimeAssemblies
    .Concat(gameAssemblies)
    .Append(asmPath)
    .Distinct(StringComparer.OrdinalIgnoreCase);
var resolver = new PathAssemblyResolver(resolverPaths);
using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
var asm = mlc.LoadFromAssemblyPath(asmPath);

var searchTerms = new[]
{
    "MonsterModel",
    "MoveState",
    "AbstractIntent",
    "Intent",
    "MonsterMove"
};

foreach (var searchTerm in searchTerms)
{
    Console.WriteLine($"=== TYPES matching *{searchTerm}* ===");
    foreach (var type in asm.GetTypes()
                 .Where(type =>
                     (type.FullName ?? string.Empty).Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                 .OrderBy(type => type.FullName, StringComparer.Ordinal))
    {
        Console.WriteLine(type.FullName);
    }

    Console.WriteLine();
}

foreach (var targetTypeName in new[]
         {
             "MegaCrit.Sts2.Core.Models.Monsters.MonsterModel",
             "MegaCrit.Sts2.Core.Models.MonsterModel",
             "MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine.MonsterMoveStateMachine",
             "MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine.MonsterState",
             "MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine.MoveState",
             "MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine.ConditionalBranchState",
             "MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine.RandomBranchState",
             "MegaCrit.Sts2.Core.MonsterMoves.Intents.AbstractIntent"
         })
{
    DumpType(asm, targetTypeName);
}

static void DumpType(Assembly assembly, string typeName)
{
    Console.WriteLine($"=== TYPE {typeName} ===");
    var type = assembly.GetType(typeName, false, false);
    if (type is null)
    {
        Console.WriteLine("<missing>");
        Console.WriteLine();
        return;
    }

    Console.WriteLine("PROPERTIES");
    foreach (var property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                 .OrderBy(property => property.Name, StringComparer.Ordinal))
    {
        Console.WriteLine($"P {property.PropertyType.FullName} {property.Name}");
    }

    Console.WriteLine("METHODS");
    foreach (var method in type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                 .OrderBy(method => method.Name, StringComparer.Ordinal))
    {
        var parameters = string.Join(
            ", ",
            method.GetParameters().Select(parameter => $"{parameter.ParameterType.FullName} {parameter.Name}"));
        Console.WriteLine($"M {method.ReturnType.FullName} {method.Name}({parameters})");
    }

    Console.WriteLine();
}
